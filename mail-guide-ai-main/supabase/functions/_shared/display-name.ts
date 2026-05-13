/**
 * 清洗邮件「显示名」：去掉 RFC5322 / 解析残留的头尾引号（ASCII 与弯引号），
 * 避免出现「，」等称呼与标点粘连错误。
 */
export function sanitizeDisplayName(raw: string | null | undefined): string {
  if (raw == null) return "";
  let s = String(raw).trim();
  for (let i = 0; i < 8; i++) {
    const next = s
      .replace(/^["'`\u201c\u2018\u201d\u2019\u300c\u300d]+/u, "")
      .replace(/["'`\u201c\u2018\u201d\u2019\u300c\u300d]+$/u, "")
      .trim();
    if (next === s) break;
    s = next;
  }
  return s;
}
