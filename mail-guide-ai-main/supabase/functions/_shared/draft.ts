import { sanitizeDisplayName } from "./display-name.ts";

// 草稿生成共享模块：本地草稿 + Dify 长草稿
// - 本地草稿（buildLocalDraft）：流水线兜底 / 6-24h 自动 / 人工再生成均使用
// - Dify 草稿（callDifyDraftWorkflow）：仅 1-6h 自动调度使用（见 schedule-draft-generation）
// 写入草稿统一走 insertDraft，幂等：同一 email_id 仅在「无非空草稿」时新建版本

export interface OrderRow {
  order_no: string;
  customer_name?: string | null;
  product_summary?: string | null;
  shipping_status?: string | null;
  tracking_no?: string | null;
  order_status?: string | null;
  amount?: number | string | null;
  currency?: string | null;
}

export interface EmailRow {
  id: string;
  subject?: string | null;
  body_text?: string | null;
  from_email?: string | null;
  from_name?: string | null;
  ai_language?: string | null;
  ai_sentiment?: string | null;
}

type DifyDraftOutputs = Record<string, unknown>;

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function formatOrderInfo(orders: OrderRow[]): string {
  if (!orders.length) return "（暂无关联订单）";
  return orders
    .map((o) => `- 订单号 ${o.order_no} | 客户 ${o.customer_name ?? ""} | 商品 ${o.product_summary ?? ""} | 物流状态 ${o.shipping_status ?? ""} | 物流单号 ${o.tracking_no ?? ""} | 订单状态 ${o.order_status ?? ""} | 金额 ${o.amount ?? ""} ${o.currency ?? ""}`)
    .join("\n");
}

type LangTemplates = {
  greetPrefix: string;
  greetSuffix: string;
  intro: string;
  tone: string;
  summaryLabel: string;
  noOrder: string;
  closing: string;
  signature: string;
};

const LANG_TEMPLATES: Record<string, LangTemplates> = {
  zh: {
    greetPrefix: "",
    greetSuffix: "，",
    intro: "感谢您的来信，我们已查看您的邮件并将协助处理您的诉求。",
    tone: "我们理解您的心情，会尽快为您处理。",
    summaryLabel: "摘要：",
    noOrder: "（暂无关联订单）",
    closing: "此致",
    signature: "客服团队",
  },
  en: {
    greetPrefix: "Hi ",
    greetSuffix: ",",
    intro: "Thank you for contacting us. We have reviewed your message and will help with your request.",
    tone: "We understand your concern and will address this promptly.",
    summaryLabel: "Summary: ",
    noOrder: "No linked order.",
    closing: "Best regards,",
    signature: "Customer Service Team",
  },
  fr: {
    greetPrefix: "Bonjour ",
    greetSuffix: ",",
    intro: "Merci de nous avoir contactés. Nous avons bien reçu votre message et nous vous aiderons.",
    tone: "Nous comprenons votre préoccupation et y répondrons rapidement.",
    summaryLabel: "Résumé : ",
    noOrder: "No linked order.",
    closing: "Cordialement,",
    signature: "Service Client",
  },
  de: {
    greetPrefix: "Hallo ",
    greetSuffix: ",",
    intro: "Vielen Dank für Ihre Nachricht. Wir haben Ihre Anfrage erhalten und helfen Ihnen gerne weiter.",
    tone: "Wir verstehen Ihr Anliegen und werden es schnellstmöglich bearbeiten.",
    summaryLabel: "Zusammenfassung: ",
    noOrder: "No linked order.",
    closing: "Mit freundlichen Grüßen,",
    signature: "Kundenservice",
  },
  ja: {
    greetPrefix: "",
    greetSuffix: " 様、",
    intro: "お問い合わせいただきありがとうございます。内容を確認し、対応いたします。",
    tone: "ご不便をおかけして申し訳ございません。迅速に対応いたします。",
    summaryLabel: "概要：",
    noOrder: "（注文情報なし）",
    closing: "よろしくお願いいたします。",
    signature: "カスタマーサポート",
  },
  es: {
    greetPrefix: "Hola ",
    greetSuffix: ",",
    intro: "Gracias por contactarnos. Hemos recibido su mensaje y le ayudaremos con su solicitud.",
    tone: "Entendemos su preocupación y la atenderemos a la brevedad posible.",
    summaryLabel: "Resumen: ",
    noOrder: "No linked order.",
    closing: "Atentamente,",
    signature: "Servicio al Cliente",
  },
  ko: {
    greetPrefix: "",
    greetSuffix: " 고객님,",
    intro: "문의해 주셔서 감사합니다. 메시지를 확인하였으며 도움을 드리겠습니다.",
    tone: "불편을 드려 죄송합니다. 신속하게 처리하겠습니다.",
    summaryLabel: "요약: ",
    noOrder: "연결된 주문이 없습니다.",
    closing: "감사합니다,",
    signature: "고객 서비스팀",
  },
};

/** 本地短草稿：按 ai_language 选对应语言模板，可不依赖外部模型 */
export function buildLocalDraft(
  email: EmailRow,
  orders: OrderRow[],
  summary?: string | null,
): string {
  const lang = (email.ai_language ?? "en").toLowerCase().trim();
  const sentiment = (email.ai_sentiment ?? "neutral").toLowerCase().trim();
  const tmpl = LANG_TEMPLATES[lang] ?? LANG_TEMPLATES["en"];

  const orderLines = orders.length
    ? orders
        .map((o) => `Order ${o.order_no}: ${o.order_status ?? "-"}, shipping ${o.shipping_status ?? "-"}`)
        .join("\n")
    : tmpl.noOrder;

  const cleaned = sanitizeDisplayName(email.from_name ?? "");
  const name = cleaned ||
    (lang === "zh" ? "您好" : lang === "ja" || lang === "ko" ? "" : "there");
  const greetLine = `${tmpl.greetPrefix}${name}${tmpl.greetSuffix}`;

  const summaryLine = summary ? `${tmpl.summaryLabel}${summary}\n` : "";

  const isAngry = sentiment === "angry" || sentiment === "frustrated";
  const toneLine = isAngry ? tmpl.tone + "\n\n" : "";

  return `${greetLine}

${tmpl.intro}
${toneLine}${summaryLine}${orderLines}

${tmpl.closing}
${tmpl.signature}`;
}

/** Dify 长草稿：通过工作流生成；返回 draft_content 字符串 */
export async function callDifyDraftWorkflow(
  email: EmailRow,
  orders: OrderRow[],
  guidance?: string | null,
): Promise<string> {
  void orders;
  const difyUrl = Deno.env.get("DIFY_DRAFT_URL");
  const difyKey = Deno.env.get("DIFY_DRAFT_KEY");
  if (!difyUrl || !difyKey) {
    throw new Error("Dify 草稿工作流未配置：DIFY_DRAFT_URL/DIFY_DRAFT_KEY");
  }

  const gatewayApiKey = Deno.env.get("DIFY_GATEWAY_API_KEY")?.trim() ?? "";
  if (!gatewayApiKey) {
    throw new Error("DIFY_GATEWAY_API_KEY 未配置：Dify 工作流无法调用 dify-gateway（HTTP 节点需 x-api-key）");
  }

  const depthNum = Number(Deno.env.get("MAX_EMAIL_THREAD_DEPTH") ?? Deno.env.get("max_search_depth") ?? "10");
  const maxSearchDepth = String(Number.isFinite(depthNum) && depthNum > 0 ? Math.min(Math.floor(depthNum), 50) : 10);

  const guidanceTrim = (guidance ?? "").trim();
  const inputs = {
    email_id: email.id,
    gateway_api_key: gatewayApiKey,
    max_search_depth: maxSearchDepth,
    guidance: guidanceTrim,
  };
  console.log(
    `[callDifyDraftWorkflow] input_keys=${JSON.stringify(Object.keys(inputs))} email_id=${email.id} guidance_len=${guidanceTrim.length}`,
  );

  const response = await fetch(difyUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${difyKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputs,
      response_mode: "blocking",
      user: "mail-guide-ai",
    }),
  });
  if (!response.ok) {
    const t = await response.text();
    throw new Error(`Dify 工作流错误 ${response.status}: ${t}`);
  }
  const json = await response.json();
  const data = json.data ?? json;
  if (data?.status === "failed" || data?.status === "stopped") {
    const errMsg =
      typeof data.error === "string"
        ? data.error
        : (data.error && JSON.stringify(data.error)) || data.message || JSON.stringify(data);
    throw new Error(`Dify 工作流执行失败: ${errMsg}`);
  }
  const outputs: DifyDraftOutputs = data?.outputs ?? {};
  return firstNonEmptyString(
    outputs.draft_reply,
    outputs.completion_draft_reply,
    outputs.draft_content,
    outputs.text,
  ) ?? "（Dify 未返回草稿内容）";
}

/** 写入新版本草稿；返回写入版本号 */
export async function insertDraft(
  admin: any,
  emailId: string,
  content: string,
  model: string,
  guidance?: string | null,
  generatedBy?: string | null,
): Promise<number> {
  const { data: prev } = await admin
    .from("ai_drafts")
    .select("version")
    .eq("email_id", emailId)
    .order("version", { ascending: false })
    .limit(1);
  const version = (prev?.[0]?.version ?? 0) + 1;
  await admin.from("ai_drafts").insert({
    email_id: emailId,
    version,
    draft_content: content,
    guidance: guidance ?? null,
    model,
    generated_by: generatedBy ?? null,
  });
  return version;
}
