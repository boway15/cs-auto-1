/** Message-ID 规范化与匹配（IMAP 补正文 UID 定位） */

export function normalizeMessageIdForCompare(messageId: string): string {
  return String(messageId ?? "")
    .replace(/^<|>$/g, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

/** 生成用于 IMAP HEADER Message-ID 搜索的候选串 */
export function buildMessageIdSearchCandidates(messageId: string): string[] {
  const raw = String(messageId ?? "").trim();
  if (!raw) return [];
  const bare = raw.replace(/^<|>$/g, "").trim();
  const withBrackets = bare.startsWith("<") ? bare : `<${bare}>`;
  const uniq = new Set<string>();
  for (const s of [raw, bare, withBrackets]) {
    if (s) uniq.add(s);
  }
  return [...uniq];
}

export function messageIdMatchesHeader(
  expectedMessageId: string,
  headerMessageId: string | null | undefined,
): boolean {
  const a = normalizeMessageIdForCompare(expectedMessageId);
  const b = normalizeMessageIdForCompare(String(headerMessageId ?? ""));
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

export function isUidNotFoundRepairError(error: string): boolean {
  return /skip_no_uid|uid_not_found|Message-ID 未命中|无法在邮箱中找到该邮件/i.test(error);
}

export function terminalUidNotFoundMessage(): string {
  return "邮箱中找不到该邮件（可能已删除、移出收件箱或 Message-ID 无法检索），无法补拉正文";
}
