import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { sendMail } from "../_shared/smtp.ts";
import { createAlertAndNotify } from "../_shared/ops-notify.ts";

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
  if (/缺陷|defect|defective|not\s*working|malfunction/i.test(text)) return "defect";
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
  return "other";
}

function analyzeLocally(email: any): Analysis {
  const text = `${email.subject ?? ""}\n${email.body_text ?? ""}`.toLowerCase();
  const orderNo = extractOrderNo(`${email.subject ?? ""}\n${email.body_text ?? ""}`);
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

  const business_intent = mapToBusinessIntent(intent, `${email.subject ?? ""}\n${email.body_text ?? ""}`);

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
    language: "en",
    sentiment: "neutral",
  };
}

async function analyzeWithAi(email: any): Promise<Analysis> {
  const difyUrl = Deno.env.get("DIFY_ANALYZE_URL");
  const difyKey = Deno.env.get("DIFY_ANALYZE_KEY") || Deno.env.get("DIFY_API_KEY");
  if (!difyUrl || !difyKey) return analyzeLocally(email);

  try {
    const response = await fetch(difyUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${difyKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        inputs: {
          subject: email.subject,
          from_email: email.from_email,
          body_text: email.body_text,
          attachments: email.attachments ?? [],
        },
        response_mode: "blocking",
        user: "mail-guide-ai",
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    const json = await response.json();
    const outputs = json.data?.outputs ?? json.answer ?? json;
    const parsed = typeof outputs === "string" ? JSON.parse(outputs) : outputs;
    const local = analyzeLocally(email);
    const merged: Analysis = { ...local, ...parsed };
    // 统一映射到 7 类（即便 Dify 直接给了 business_intent，也要校验）
    const text = `${email.subject ?? ""}\n${email.body_text ?? ""}`;
    const candidate = (parsed?.business_intent as string) ?? merged.intent;
    merged.business_intent = mapToBusinessIntent(candidate, text);
    const p = parsed as Record<string, unknown>;
    merged.language = normalizeLanguage(p?.language ?? merged.language);
    merged.sentiment = normalizeSentiment(p?.sentiment ?? merged.sentiment);
    return merged;
  } catch (error) {
    console.error("AI analyze fallback:", error);
    return analyzeLocally(email);
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
      await admin.from("order_compensation_tasks").upsert({
        email_id: email.id,
        order_no: analysis.order_no,
        status: "pending",
        next_run_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }, { onConflict: "email_id,order_no" });
      await recordEvent(admin, email.id, "compensation_created", `订单 ${analysis.order_no} 暂未查到，已创建补偿任务`);
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

async function processEmail(emailId: string) {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: email, error } = await admin.from("emails").select("*").eq("id", emailId).single();
  if (error || !email) throw new Error("邮件不存在");

  await admin.from("emails").update({ processing_status: "analyzing" }).eq("id", emailId);
  const analysis = await analyzeWithAi(email);

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
  await recordEvent(admin, emailId, "ai_analyzed", "AI 分析完成", analysis.summary, analysis as any);

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
        null,
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
    const results = [];
    for (const emailId of emailIds) {
      results.push({ email_id: emailId, ...(await processEmail(emailId)) });
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
