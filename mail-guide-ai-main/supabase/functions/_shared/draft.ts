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

export function formatOrderInfo(orders: OrderRow[]): string {
  if (!orders.length) return "（暂无关联订单）";
  return orders
    .map((o) => `- 订单号 ${o.order_no} | 客户 ${o.customer_name ?? ""} | 商品 ${o.product_summary ?? ""} | 物流状态 ${o.shipping_status ?? ""} | 物流单号 ${o.tracking_no ?? ""} | 订单状态 ${o.order_status ?? ""} | 金额 ${o.amount ?? ""} ${o.currency ?? ""}`)
    .join("\n");
}

/** 本地短草稿：按 ai_language 选中英模板，可不依赖外部模型 */
export function buildLocalDraft(
  email: EmailRow,
  orders: OrderRow[],
  summary?: string | null,
): string {
  const lang = (email.ai_language ?? "en").toLowerCase().trim();
  const sentiment = (email.ai_sentiment ?? "neutral").toLowerCase().trim();
  const orderLines = orders.length
    ? orders
        .map((o) => `Order ${o.order_no}: ${o.order_status ?? "-"}, shipping ${o.shipping_status ?? "-"}`)
        .join("\n")
    : lang === "zh" ? "（暂无关联订单）" : "No linked order.";
  const greet = email.from_name ?? (lang === "zh" ? "您好" : "there");
  const summaryLine = summary
    ? lang === "zh"
      ? `摘要：${summary}\n`
      : `Summary: ${summary}\n`
    : "";
  const tone =
    sentiment === "angry" || sentiment === "frustrated"
      ? lang === "zh"
        ? "我们理解您的心情，会尽快为您处理。"
        : "We understand your concern and will address this promptly."
      : "";

  if (lang === "zh") {
    return `${greet}，

感谢您的来信，我们已查看您的邮件并将协助处理您的诉求。
${tone ? tone + "\n\n" : ""}${summaryLine}${orderLines}

此致
客服团队`;
  }

  return `Hi ${greet},

Thank you for contacting us. We have reviewed your message and will help with your request.
${tone ? tone + "\n\n" : ""}
${summaryLine}${orderLines}

Best regards,
Customer Service Team`;
}

/** Dify 长草稿：通过工作流生成；返回 draft_content 字符串 */
export async function callDifyDraftWorkflow(
  email: EmailRow,
  orders: OrderRow[],
  guidance?: string | null,
  previousDraft?: string | null,
): Promise<string> {
  const difyUrl = Deno.env.get("DIFY_DRAFT_URL");
  const difyKey = Deno.env.get("DIFY_DRAFT_KEY");
  if (!difyUrl || !difyKey) {
    throw new Error("Dify 草稿工作流未配置：DIFY_DRAFT_URL/DIFY_DRAFT_KEY");
  }

  const orderInfo = formatOrderInfo(orders);
  const response = await fetch(difyUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${difyKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputs: {
        subject: email.subject ?? "",
        body_text: email.body_text ?? "",
        from_name: email.from_name ?? email.from_email ?? "",
        from_email: email.from_email ?? "",
        order_info: orderInfo,
        guidance: guidance ?? "",
        previous_draft: previousDraft ?? "",
      },
      response_mode: "blocking",
      user: "mail-guide-ai",
    }),
  });
  if (!response.ok) {
    const t = await response.text();
    throw new Error(`Dify 工作流错误 ${response.status}: ${t}`);
  }
  const json = await response.json();
  const outputs = json.data?.outputs ?? json;
  return outputs.draft_content ?? outputs.text ?? "（Dify 未返回草稿内容）";
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
