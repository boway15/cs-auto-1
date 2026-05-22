export type MailboxSignatureFields = {
  signature_enabled?: boolean | null;
  signature_text?: string | null;
};

/** 发件邮箱开启签名且内容非空时，在正文末尾追加签名（双换行分隔） */
export function appendMailboxSignature(
  body: string,
  mailbox: MailboxSignatureFields,
): string {
  if (!mailbox.signature_enabled) return body;
  const sig = (mailbox.signature_text ?? "").trim();
  if (!sig) return body;
  const base = body.trimEnd();
  return base ? `${base}\n\n${sig}` : sig;
}
