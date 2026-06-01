/** 将纯文本邮件正文转为 HTML（转义 + 换行 + 邮箱/URL 可点击链接） */

const LINK_TOKEN =
  /(https?:\/\/[^\s<>"'\]]+|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/** 单行/片段内将邮箱与 http(s) URL 转为 <a>（输入须为未转义原文） */
export function linkifyPlainTextFragment(text: string): string {
  const parts: string[] = [];
  let last = 0;
  LINK_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_TOKEN.exec(text)) !== null) {
    parts.push(escapeHtml(text.slice(last, m.index)));
    const raw = m[0];
    if (/^https?:\/\//i.test(raw)) {
      parts.push(
        `<a href="${escapeAttr(raw)}">${escapeHtml(raw)}</a>`,
      );
    } else {
      parts.push(
        `<a href="mailto:${escapeAttr(raw)}">${escapeHtml(raw)}</a>`,
      );
    }
    last = m.index + raw.length;
  }
  parts.push(escapeHtml(text.slice(last)));
  return parts.join("");
}

/** 完整邮件正文：保留换行，生成简单 HTML 文档 */
export function plainTextToHtmlEmail(text: string): string {
  const body = text
    .split(/\n/)
    .map((line) => linkifyPlainTextFragment(line))
    .join("<br>\n");
  return (
    `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>` +
    `<body style="font-family: sans-serif; font-size: 14px; line-height: 1.5;">` +
    `${body}</body></html>`
  );
}
