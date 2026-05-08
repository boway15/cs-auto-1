export function extractOrderNo(text: string): string | null {
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

export function getMissingElements(input: {
  subject?: string | null;
  body_text?: string | null;
  has_attachment?: boolean | null;
}) {
  const text = `${input.subject ?? ""}\n${input.body_text ?? ""}`.toLowerCase();
  const missing = new Set<string>();
  const orderNo = extractOrderNo(text);
  const afterSale = /refund|return|broken|damage|wrong|missing|replace|cancel|address|退款|退货|损坏|取消|地址/.test(text);
  const needsImage = /broken|damage|wrong item|defect|损坏|破损|错发|瑕疵/.test(text);

  if (afterSale && !orderNo) missing.add("order_no");
  if (needsImage && !input.has_attachment) missing.add("image");
  return Array.from(missing);
}

export async function createSendIdempotencyKey(emailId: string, userId: string, content: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  const contentHash = Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `manual:${emailId}:${userId}:${contentHash}`;
}
