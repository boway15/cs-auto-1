/** 兼容 `Name <a@b.com>` 与纯地址，用于比较 From / Reply-To。 */
export function normalizeEmailAddress(s: string | null | undefined): string {
  const t = String(s ?? "").trim().toLowerCase();
  if (!t) return "";
  const angle = t.match(/<([^>]+@[^>]+)>/);
  return (angle ? angle[1] : t).trim();
}

/**
 * From ≠ Reply-To 时需客服二次确认（仿网易邮箱防误回）。
 * reply_to_email 为空时不弹窗（发信回退 from_email）。
 */
export function needsReplyToConfirm(email: {
  from_email?: string | null;
  reply_to_email?: string | null;
}): boolean {
  const replyTo = normalizeEmailAddress(email.reply_to_email);
  if (!replyTo) return false;
  const from = normalizeEmailAddress(email.from_email);
  return Boolean(from) && replyTo !== from;
}
