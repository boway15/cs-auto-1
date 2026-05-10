import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { sendMail } from "../_shared/smtp.ts";
import { createAlertAndNotify } from "../_shared/ops-notify.ts";
import {
  erpEnvelopeNoOrderMessage,
  erpEnvelopeOmsQuerySucceeded,
  isErpOmsConfigured,
  queryOrderInfo,
} from "../_shared/erp-client.ts";
import { upsertOrderFromOmsData } from "../_shared/erp-order-sync.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CUSTOMER_AUTO_REPLY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function envBool(key: string, defaultValue: boolean): boolean {
  const v = Deno.env.get(key);
  if (v == null || v === "") return defaultValue;
  return !/^false|0|off|no$/i.test(v.trim());
}

function normalizeLanguage(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "zh" || s === "zh-cn" || s === "zh_cn" || s === "chinese") return "zh";
  if (s === "en" || s === "english") return "en";
  if (s === "other") return "other";
  if (s.length > 0 && s.length <= 16) return s;
  return "en";
}

function normalizeSentiment(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (["angry", "frustrated", "neutral", "happy"].includes(s)) return s;
  return "neutral";
}

function getCustomerAutoReplyBlockReason(email: { received_at?: string | null }): string | null {
  if (!envBool("AUTO_REPLY_CUSTOMER_ENABLED", true)) return "master_switch_off";
  const ra = email.received_at;
  if (!ra) return "missing_received_at";
  const ms = Date.now() - new Date(ra).getTime();
  if (Number.isNaN(ms) || ms < 0) return "invalid_received_at";
  if (ms > CUSTOMER_AUTO_REPLY_MAX_AGE_MS) return "outside_24h_window";
  return null;
}

type BusinessIntent =
  | "order_cancel"
  | "address_change"
  | "damaged"
  | "defect"
  | "description_mismatch"
  | "logistics"
  | "other";

const VALID_BUSINESS_INTENTS: ReadonlyArray<BusinessIntent> = [
  "order_cancel",
  "address_change",
  "damaged",
  "defect",
  "description_mismatch",
  "logistics",
  "other",
];

type Analysis = {
  intent: string;
  business_intent: BusinessIntent;
  category: string;
  order_no: string | null;
  missing_elements: string[];
  is_info_complete: boolean;
  summary: string;
  priority: "low" | "normal" | "high" | "urgent";
  risk_level: "normal" | "high";
  entities: Record<string, unknown>;
  language: string;
  sentiment: string;
};

type SendTemplateReplyOptions = {
  extraTriggerTypes?: string[];
  requireRiskMissingOrderSwitch?: boolean;
};

function extractOrderNo(text: string) {
  const patterns = [
    /\b(?:order|订单|orderno|order\s*no\.?)\s*[:#：]?\s*([A-Z0-9][A-Z0-9-]{5,})\b/i,
    /\b(SO\d{6,}|[A-Z]{2,4}-?\d{6,}|\d{8,})\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].replace(/^#/, "").trim();
  }
  return null;
}

/** 将 Dify/本地 intent 与关键词信号映射到 7 类 business_intent */
function mapToBusinessIntent(rawIntent: string | undefined, text: string): BusinessIntent {
  // 规则优先：取消、改地址直接锁死
  if (rawIntent === "cancel_order" || /取消订单|cancel\s*order|cancel\s*the\s*order/i.test(text)) {
    return "order_cancel";
  }
  if (rawIntent === "change_address" || /修改地址|change\s*address|update\s*address/i.test(text)) {
    return "address_change";
  }
  // 关键词识别细分售后
  if (/破损|broken|damage|damaged|crushed/i.test(text)) return "damaged";
  // 质量问题 / 品质差等口语归入 defect（与「缺陷」同档，区别于单纯描述不符）
  if (
    /缺陷|defect|defective|not\s*working|malfunction|质量问题|品质问题|质量差|做工差|品控差|品控问题|次品|劣质/i.test(text)
  ) {
    return "defect";
  }
  if (/描述不符|与描述不符|不符|mismatch|not\s*as\s*described|wrong\s*item/i.test(text)) {
    return "description_mismatch";
  }
  // logistics / shipping_query
  if (
    rawIntent === "shipping_query" ||
    rawIntent === "logistics" ||
    /物流|快递|发货|shipping|tracking|delivery|package/i.test(text)
  ) {
    return "logistics";
  }
  // 已知映射的兜底
  if (rawIntent && VALID_BUSINESS_INTENTS.includes(rawIntent as BusinessIntent)) {
    return rawIntent as BusinessIntent;
  }
  // Dify/本地 legacy：intent 为 after_sale、refund 时，上面细分关键词未命中则不再一律 other（常见中文售后用语）
  if (
    rawIntent === "after_sale" ||
    rawIntent === "refund"
  ) {
    if (/退款|退货|换货|赔偿|补偿|质量问题|瑕疵|次品|少发|漏发|错发|发错|不符|描述|假货|仿品|不满意|投诉|差评|坏了|破损|损坏|缺陷|不能用|故障|漏液|开裂|碎裂|变形|污渍|褪色|掉色|缩水|起球|异味|过期|变质/i.test(text)) {
      return "description_mismatch";
    }
  }
  return "other";
}

function analyzeLocally(email: any): Analysis {
  const rawText = `${email.subject ?? ""}\n${email.body_text ?? ""}`;
  const text = rawText.toLowerCase();
  const orderNo = extractOrderNo(rawText);
  const missing = new Set<string>();
  const isAfterSale = /refund|return|broken|damage|wrong|missing|replace|cancel|address|退款|退货|损坏|取消|地址/.test(text);
  const needsImage = /broken|damage|wrong item|defect|损坏|破损|错发|瑕疵/.test(text);
  const risk = /cancel|change address|修改地址|取消订单|拦截|stop shipment/.test(text);

  if (isAfterSale && !orderNo) missing.add("order_no");
  if (needsImage && !email.has_attachment) missing.add("image");

  const intent = risk
    ? (/address|地址/.test(text) ? "change_address" : "cancel_order")
    : /refund|退款/.test(text)
    ? "refund"
    : /track|shipping|物流|快递|发货/.test(text)
    ? "shipping_query"
    : isAfterSale
    ? "after_sale"
    : "general";

  const business_intent = mapToBusinessIntent(intent, rawText);

  // 语言识别：检测中文字符
  const hasChinese = /[\u4e00-\u9fa5]/.test(rawText);
  const detectedLanguage = hasChinese ? "zh" : "en";

  // 情绪识别：关键词信号
  const isAngry = /angry|frustrated|terrible|awful|horrible|worst|unacceptable|outrageous|投诉|愤怒|太差|极差|不满|差评|欺骗|骗子/.test(text);

  const summarySource = (email.body_text ?? email.subject ?? "").replace(/\s+/g, " ").trim();
  return {
    intent,
    business_intent,
    category: isAfterSale ? "售后" : "咨询",
    order_no: orderNo,
    missing_elements: Array.from(missing),
    is_info_complete: missing.size === 0,
    summary: summarySource.slice(0, 220) || "暂无正文",
    priority: risk ? "urgent" : isAfterSale ? "high" : "normal",
    risk_level: risk ? "high" : "normal",
    entities: { order_no: orderNo, from_email: email.from_email },
    language: detectedLanguage,
    sentiment: isAngry ? "frustrated" : "neutral",
  };
}

async function analyzeWithAi(email: any): Promise<{
  analysis: Analysis;
  source: "dify" | "local";
  difyError?: string | null;
  workflowRunId?: string | null;
}> {
  const difyUrl = Deno.env.get("DIFY_ANALYZE_URL");
  const difyKey = Deno.env.get("DIFY_ANALYZE_KEY") || Deno.env.get("DIFY_API_KEY");
  if (!difyUrl || !difyKey) {
    return { analysis: analyzeLocally(email), source: "local", difyError: "missing_dify_env" };
  }

  // Dify「文档列表 / 文件列表」变量 attachment_files：每项为 { type, transfer_method, url? | upload_file_id? }
  // 当前同步链路尚未上传真实附件，默认传空数组；有公开 URL 或 upload_file_id 时可在此组装。
  const attachmentFiles: Array<{
    type: "document" | "image" | "audio" | "video" | "custom";
    transfer_method: "remote_url" | "local_file";
    url?: string;
    upload_file_id?: string;
  }> = [];

  try {
    const response = await fetch(difyUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${difyKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        inputs: {
          subject: String(email.subject ?? ""),
          from_email: String(email.from_email ?? ""),
          body_text: String(email.body_text ?? ""),
          // Dify 工作流将 attachments 定义为 text-input(string)，必须序列化
          attachments: Array.isArray(email.attachments)
            ? JSON.stringify(email.attachments)
            : (email.attachments == null ? "" : String(email.attachments)),
          attachment_files: attachmentFiles,
        },
        response_mode: "blocking",
        user: "mail-guide-ai",
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    const json = await response.json();
    const workflowRunId =
      typeof json.workflow_run_id === "string"
        ? json.workflow_run_id
        : typeof json?.data?.workflow_run_id === "string"
        ? json.data.workflow_run_id
        : typeof json?.data?.id === "string"
        ? json.data.id
        : null;
    const outputs = json.data?.outputs ?? json.answer ?? json;
    const parsed = typeof outputs === "string" ? JSON.parse(outputs) : outputs;
    const local = analyzeLocally(email);
    const merged: Analysis = { ...local, ...parsed };
    // 统一映射到 7 类（即便 Dify 直接给了 business_intent，也要校验）
    const text = `${email.subject ?? ""}\n${email.body_text ?? ""}`;
    const p = parsed as Record<string, unknown>;
    const biRaw = typeof p?.business_intent === "string" ? p.business_intent.trim() : "";
    const intentRaw = typeof p?.intent === "string" ? p.intent.trim() : "";
    // Dify 可能返回 business_intent 为空串；或模型把 business_intent 一律标 other 但 intent 仍有 after_sale 等语义
    let effective = biRaw || intentRaw || String(merged.intent ?? "");
    if (biRaw === "other" && intentRaw && intentRaw !== "general") {
      effective = intentRaw;
    }
    merged.business_intent = mapToBusinessIntent(effective, text);
    merged.language = normalizeLanguage(p?.language ?? merged.language);
    merged.sentiment = normalizeSentiment(p?.sentiment ?? merged.sentiment);
    return { analysis: merged, source: "dify", workflowRunId };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("AI analyze fallback:", msg);
    return { analysis: analyzeLocally(email), source: "local", difyError: msg };
  }
}

function renderTemplate(template: string, email: any, analysis: Analysis) {
  const values: Record<string, string> = {
    from_name: email.from_name ?? email.from_email,
    from_email: email.from_email,
    subject: email.subject ?? "",
    order_no: analysis.order_no ?? "",
    missing_elements: analysis.missing_elements.join(", "),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key) => values[key] ?? "");
}

async function recordEvent(admin: any, emailId: string, event_type: string, title: string, detail?: string, metadata = {}) {
  await admin.from("email_processing_events").insert({
    email_id: emailId,
    event_type,
    title,
    detail: detail ?? null,
    metadata,
  });
}

async function sendTemplateReply(
  admin: any,
  email: any,
  analysis: Analysis,
  options?: SendTemplateReplyOptions,
) {
  const block = getCustomerAutoReplyBlockReason(email);
  if (block) {
    await recordEvent(admin, email.id, "auto_reply_skipped", "跳过自动回复", block, { reason: block });
    return false;
  }
  if (options?.requireRiskMissingOrderSwitch && !envBool("AUTO_REPLY_RISK_MISSING_ORDER_NO", false)) {
    await recordEvent(admin, email.id, "auto_reply_skipped", "取消/改地址缺单号自动回复未开启", "", {
      reason: "risk_missing_order_switch_off",
    });
    return false;
  }

  const triggerCandidates = [
    ...(options?.extraTriggerTypes ?? []),
    analysis.missing_elements.includes("order_no") ? "missing_order_no" : null,
    analysis.missing_elements.includes("image") ? "missing_image" : null,
    analysis.missing_elements.includes("product") ? "missing_product" : null,
    analysis.missing_elements.length > 0 ? "missing_any" : null,
  ].filter(Boolean) as string[];

  const uniqueTriggers = [...new Set(triggerCandidates)];
  if (uniqueTriggers.length === 0) {
    await recordEvent(admin, email.id, "auto_reply_skipped", "无有效模板触发类型", "", {
      reason: "no_trigger_types",
    });
    return false;
  }

  const { data: templates } = await admin
    .from("reply_templates")
    .select("*")
    .eq("is_active", true)
    .eq("auto_send", true)
    .in("trigger_type", uniqueTriggers);

  const template = templates?.[0];
  if (!template) return false;

  const cooldownMs = Number(template.cooldown_minutes ?? 120) * 60 * 1000;
  const since = new Date(Date.now() - cooldownMs).toISOString();
  const { data: recent } = await admin
    .from("email_send_logs")
    .select("id")
    .eq("email_id", email.id)
    .eq("template_id", template.id)
    .gte("created_at", since)
    .limit(1);
  if (recent?.length) return false;

  const { data: mailbox } = await admin.from("mailboxes").select("*").eq("id", email.mailbox_id).single();
  if (!mailbox?.smtp_host || !mailbox?.smtp_port) return false;

  const subject = renderTemplate(template.subject_template || `Re: ${email.subject ?? ""}`, email, analysis);
  const content = renderTemplate(template.body_template, email, analysis);
  let messageId = "";
  let sendError: string | null = null;
  try {
    messageId = await sendMail(mailbox, {
      to: email.from_email,
      subject,
      text: content,
      inReplyTo: email.message_id ?? undefined,
      references: email.message_id ?? undefined,
    });
  } catch (error) {
    sendError = error instanceof Error ? error.message : String(error);
  }

  await admin.from("email_send_logs").insert({
    email_id: email.id,
    mailbox_id: mailbox.id,
    to_email: email.from_email,
    from_email: mailbox.email_address,
    subject,
    content,
    send_type: "auto_template",
    status: sendError ? "failed" : "sent",
    error_message: sendError,
    message_id: messageId || null,
    template_id: template.id,
    idempotency_key: `template:${email.id}:${template.id}`,
  });

  if (sendError) throw new Error(sendError);
  await admin.from("emails").update({ status: "replied", processing_status: "auto_replied" }).eq("id", email.id);
  await recordEvent(admin, email.id, "auto_reply_sent", "信息缺失模板已自动回复", template.name);
  return true;
}

async function associateOrders(admin: any, email: any, analysis: Analysis) {
  const linkedOrders: any[] = [];
  if (analysis.order_no) {
    const { data: order } = await admin
      .from("orders")
      .select("*")
      .ilike("order_no", analysis.order_no)
      .maybeSingle();
    if (order) {
      await admin.from("email_order_links").upsert({
        email_id: email.id,
        order_id: order.id,
        link_source: "auto",
        confidence: 1,
        metadata: { matched_order_no: analysis.order_no },
      }, { onConflict: "email_id,order_id" });
      linkedOrders.push(order);
      await recordEvent(admin, email.id, "order_linked", `自动关联订单 ${order.order_no}`);
    } else {
      let resolvedViaErp: any = null;
      let omsTraceId: string | undefined;
      if (isErpOmsConfigured() && email.from_email) {
        try {
          const r = await queryOrderInfo(email.from_email, analysis.order_no ?? "");
          omsTraceId = r.envelope.traceId;
          const inner = r.envelope.data;
          if (r.ok && inner && typeof inner === "object" && erpEnvelopeOmsQuerySucceeded(r.envelope)) {
            const up = await upsertOrderFromOmsData(admin, inner as Record<string, unknown>, email.from_email);
            if (up) {
              const { data: o2 } = await admin.from("orders").select("*").eq("id", up.id).maybeSingle();
              if (o2) resolvedViaErp = o2;
            }
          } else if (!erpEnvelopeNoOrderMessage(r.envelope)) {
            await recordEvent(
              admin,
              email.id,
              "oms_query_order_failed",
              "OMS 查单未成功",
              String(r.envelope.data?.message ?? r.rawText?.slice(0, 300) ?? ""),
              {
                trace_id: omsTraceId ?? null,
                http_status: r.httpStatus,
              },
            );
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("associateOrders OMS:", msg);
          await recordEvent(admin, email.id, "oms_query_order_error", "OMS 查单异常", msg, {});
        }
      }
      if (resolvedViaErp) {
        await admin.from("email_order_links").upsert({
          email_id: email.id,
          order_id: resolvedViaErp.id,
          link_source: "auto",
          confidence: 1,
          metadata: { matched_order_no: analysis.order_no, source: "erp_oms", trace_id: omsTraceId ?? null },
        }, { onConflict: "email_id,order_id" });
        linkedOrders.push(resolvedViaErp);
        await recordEvent(admin, email.id, "order_linked", `自动关联订单 ${resolvedViaErp.order_no}（OMS）`, undefined, {
          matched_order_no: analysis.order_no,
          trace_id: omsTraceId ?? null,
        });
      } else {
        await admin.from("order_compensation_tasks").upsert({
          email_id: email.id,
          order_no: analysis.order_no,
          status: "pending",
          next_run_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        }, { onConflict: "email_id,order_no" });
        await recordEvent(admin, email.id, "compensation_created", `订单 ${analysis.order_no} 暂未查到，已创建补偿任务`);
      }
    }
  }
  // 未提供口径：无单号且未链接 → 不做订单推荐
  return linkedOrders;
}

function computeSlaBucket(receivedAt: string | null | undefined): string | null {
  if (!receivedAt) return null;
  const ms = Date.now() - new Date(receivedAt).getTime();
  if (Number.isNaN(ms)) return null;
  const hour = ms / 3_600_000;
  if (hour < 24) return "within_24h";
  if (hour < 48) return "within_48h";
  if (hour < 72) return "within_72h";
  return "over_72h";
}

type ProcessEmailOptions = { analyzeOnly?: boolean };

/** 仅重跑 AI 分析并写回分析字段，不触发关联订单、风控、自动回复等（用于人工/Dify 联调） */
async function processEmailAnalyzeOnly(
  admin: any,
  emailId: string,
  analysis: Analysis,
  analyzeSource: "dify" | "local",
  analyzeDifyError: string | null | undefined,
  workflowRunId: string | null | undefined,
) {
  await admin.from("emails").update({
    intent: analysis.intent,
    intent_legacy: analysis.intent,
    business_intent: analysis.business_intent,
    category: analysis.category,
    missing_elements: analysis.missing_elements,
    ai_entities: analysis.entities,
    is_info_complete: analysis.is_info_complete,
    ai_summary: analysis.summary,
    ai_language: analysis.language,
    ai_sentiment: analysis.sentiment,
    ai_analyzed_at: new Date().toISOString(),
    priority: analysis.priority,
    risk_level: analysis.risk_level,
  }).eq("id", emailId);

  if (analyzeSource === "local" && analyzeDifyError) {
    await recordEvent(
      admin,
      emailId,
      analyzeDifyError === "missing_dify_env" ? "ai_analyze_dify_missing_env" : "ai_analyze_dify_failed",
      analyzeDifyError === "missing_dify_env"
        ? "再次分析：未配置 DIFY_ANALYZE_URL/KEY，使用本地规则"
        : "再次分析：Dify 调用失败，已回落本地规则",
      analyzeDifyError,
      { fallback: "local", analyze_only: true },
    );
  }

  await recordEvent(
    admin,
    emailId,
    "ai_reanalyzed",
    analyzeSource === "dify" ? "再次分析完成（Dify 工作流）" : "再次分析完成（本地规则）",
    analysis.summary,
    {
      ...(analysis as Record<string, unknown>),
      analyze_engine: analyzeSource,
      workflow_run_id: workflowRunId ?? null,
      analyze_only: true,
    },
  );
}

async function processEmail(emailId: string, options?: ProcessEmailOptions) {
  const analyzeOnly = options?.analyzeOnly === true;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: email, error } = await admin.from("emails").select("*").eq("id", emailId).single();
  if (error || !email) throw new Error("邮件不存在");

  if (!analyzeOnly) {
    await admin.from("emails").update({ processing_status: "analyzing" }).eq("id", emailId);
  }
  const { analysis, source: analyzeSource, difyError: analyzeDifyError, workflowRunId } =
    await analyzeWithAi(email);
  if (analyzeSource === "local" && !analyzeOnly) {
    await recordEvent(
      admin,
      emailId,
      analyzeDifyError === "missing_dify_env" ? "ai_analyze_dify_missing_env" : "ai_analyze_dify_failed",
      analyzeDifyError === "missing_dify_env"
        ? "未配置 DIFY_ANALYZE_URL/KEY，使用本地规则分析"
        : "Dify 分析调用失败，已回落本地规则",
      analyzeDifyError ?? undefined,
      { fallback: "local" },
    );
  }

  if (analyzeOnly) {
    await processEmailAnalyzeOnly(
      admin,
      emailId,
      analysis,
      analyzeSource,
      analyzeDifyError,
      workflowRunId,
    );
    return { analysis, associationStatus: email.association_status ?? "unlinked", routed: "analyze_only" as const };
  }

  // 判断是否为近 30 天首封邮件（来自同一发件人）
  let isFirstEmail = false;
  if (email.from_email) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentEmails } = await admin
      .from("emails")
      .select("id")
      .eq("from_email", email.from_email)
      .neq("id", email.id)
      .gte("received_at", thirtyDaysAgo)
      .limit(1);
    isFirstEmail = !recentEmails || recentEmails.length === 0;
  }

  const slaBucket = computeSlaBucket(email.received_at);

  await admin.from("emails").update({
    intent: analysis.intent,
    intent_legacy: analysis.intent,
    business_intent: analysis.business_intent,
    category: analysis.category,
    missing_elements: analysis.missing_elements,
    ai_entities: analysis.entities,
    is_info_complete: analysis.is_info_complete,
    ai_summary: analysis.summary,
    ai_language: analysis.language,
    ai_sentiment: analysis.sentiment,
    ai_analyzed_at: new Date().toISOString(),
    priority: analysis.priority,
    risk_level: analysis.risk_level,
    thread_id: email.thread_id ?? email.message_id ?? email.id,
    is_first_email: isFirstEmail,
    sla_bucket: ["pending", "processing"].includes(email.status) ? slaBucket : null,
  }).eq("id", emailId);
  await recordEvent(
    admin,
    emailId,
    "ai_analyzed",
    analyzeSource === "dify"
      ? "AI 分析完成（Dify：独立站智能客服-邮件智能分析）"
      : "AI 分析完成（本地规则，未调用 Dify）",
    analysis.summary,
    {
      ...(analysis as Record<string, unknown>),
      analyze_engine: analyzeSource,
      workflow_run_id: workflowRunId ?? null,
    },
  );

  const linkedOrders = await associateOrders(admin, email, analysis);
  // 关联状态语义：
  //   linked        - 已关联订单
  //   compensating  - 客户提供单号但暂未匹配，已创建补偿任务
  //   not_provided  - 未提供单号且无关联（不推荐）
  const associationStatus = linkedOrders.length
    ? "linked"
    : analysis.order_no
    ? "compensating"
    : "not_provided";

  await admin.from("emails").update({
    association_status: associationStatus,
    processing_status: linkedOrders.length ? "associated" : "pending",
    status: email.status === "pending" && analysis.priority === "urgent" ? "processing" : email.status,
  }).eq("id", emailId);

  // 拦截分流：取消/改地址 + 已关联订单 → 必拦
  const mustIntercept =
    (analysis.business_intent === "order_cancel" || analysis.business_intent === "address_change");

  if (mustIntercept && linkedOrders.length) {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/risk-intercept`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email_id: emailId,
        order_id: linkedOrders[0].id,
        action: "hold",
        intercept_reason: analysis.summary,
        reason_category: analysis.business_intent,
        trigger_source: "auto",
      }),
    });
    if (!response.ok) {
      const errText = await response.text();
      await recordEvent(admin, emailId, "risk_intercept_failed", "调用 risk-intercept 失败", errText);
      await createAlertAndNotify(admin, {
        source: "process-email",
        kind: "risk_intercept_http_failed",
        title: "风控拦截调用失败",
        message: errText,
        related_email_id: emailId,
        related_order_id: linkedOrders[0].id,
        severity: "critical",
        metadata: { http_status: response.status },
      });
    } else {
      await recordEvent(admin, emailId, "risk_intercept_requested", "已触发自动风控拦截");
    }
    // 保留 risk-intercept 写入的 processing_status（如 risk_intercepted），仅保证 status 可被 schedule-draft 选中
    await admin.from("emails").update({ status: "processing" }).eq("id", emailId);
    await recordEvent(admin, emailId, "draft_pending", "已进入草稿待生成队列（由调度任务负责）");
    return { analysis, associationStatus, routed: "risk_intercept" };
  }

  if (mustIntercept && !linkedOrders.length) {
    if (associationStatus === "compensating") {
      await recordEvent(
        admin,
        emailId,
        "risk_intercept_deferred_compensating",
        "取消/改地址：已提供单号但未关联，不拦截；满 2h 后由调度发内部预警",
        undefined,
        { order_no: analysis.order_no },
      );
    } else {
      try {
        const sent = await sendTemplateReply(admin, email, analysis, {
          extraTriggerTypes: ["risk_missing_order_no", "missing_order_no", "missing_any"],
          requireRiskMissingOrderSwitch: true,
        });
        if (sent) {
          return { analysis, associationStatus, routed: "auto_template_risk" };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await createAlertAndNotify(admin, {
          source: "process-email",
          kind: "auto_reply_failed",
          title: "取消/改地址自动回复失败",
          message: msg,
          related_email_id: emailId,
          severity: "warning",
        });
        return { analysis, associationStatus, routed: "auto_template_failed" };
      }
      await recordEvent(
        admin,
        emailId,
        "risk_intercept_skipped_no_order",
        "意图为取消/改地址但无关联订单，未自动拦截",
      );
    }
  }

  // 条件：首封邮件 + 售后意图 + 信息不完整（缺订单号或缺附件）→ 自动按模板回复
  const isAfterSaleLike =
    analysis.intent === "after_sale" ||
    ["damaged", "defect", "description_mismatch"].includes(analysis.business_intent);
  if (isFirstEmail && isAfterSaleLike && !analysis.is_info_complete) {
    try {
      const sent = await sendTemplateReply(admin, email, analysis);
      return { analysis, associationStatus, routed: sent ? "auto_template" : "manual_missing_info" };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await createAlertAndNotify(admin, {
        source: "process-email",
        kind: "auto_reply_failed",
        title: "自动模板回复失败",
        message: msg,
        related_email_id: emailId,
        severity: "warning",
      });
      return { analysis, associationStatus, routed: "auto_template_failed" };
    }
  }

  // 非首封或非售后但信息不完整 → 标记待人工处理
  if (!analysis.is_info_complete) {
    await admin.from("emails").update({
      processing_status: "pending",
      status: "pending",
    }).eq("id", emailId);
    await recordEvent(admin, emailId, "manual_needed", "信息不完整，需人工处理");
    return { analysis, associationStatus, routed: "manual_missing_info" };
  }

  // 草稿生成统一交给 schedule-draft-generation（避免双写），此处只记待生成事件
  if (linkedOrders.length) {
    await admin.from("emails").update({ processing_status: "draft_pending", status: "processing" }).eq("id", emailId);
    await recordEvent(admin, emailId, "draft_pending", "已进入草稿待生成队列（由调度任务负责）");
    return { analysis, associationStatus, routed: "draft_pending" };
  }

  return { analysis, associationStatus, routed: "manual" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const emailIds = Array.isArray(body.email_ids) ? body.email_ids : [body.email_id].filter(Boolean);
    if (emailIds.length === 0) {
      return new Response(JSON.stringify({ error: "缺少 email_id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const analyzeOnly = body.analyze_only === true || body.mode === "analyze_only";
    if (analyzeOnly && emailIds.length !== 1) {
      return new Response(JSON.stringify({ error: "analyze_only 仅支持单次处理一封邮件" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const results = [];
    for (const emailId of emailIds) {
      results.push({
        email_id: emailId,
        ...(await processEmail(emailId, { analyzeOnly })),
      });
    }
    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("process-email error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
