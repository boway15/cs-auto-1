import { supabase } from "@/lib/supabase";
import { formatFunctionsInvokeError } from "@/lib/format-functions-invoke-error";

export function isEmailBodyEmpty(email: {
  body_text?: string | null;
  body_html?: string | null;
}): boolean {
  return !hasReadableEmailBodyForDisplay(email.body_text, email.body_html);
}

/** 正文需补拉：库内为空，或未解码的 base64 脏数据，或仅 MIME 头 */
export function needsEmailBodyRepair(email: {
  body_text?: string | null;
  body_html?: string | null;
}): boolean {
  if (isEmailBodyEmpty(email)) return true;
  if (isUndecodedBase64Body(email.body_text) || isUndecodedBase64Body(email.body_html)) {
    return true;
  }
  if (isMimeHeadersOnlyBody(email.body_text) || isMimeHeadersOnlyBody(email.body_html)) {
    return true;
  }
  return false;
}

function looksLikeBase64Payload(s: string): boolean {
  const flat = s.replace(/\s/g, "");
  if (flat.length < 16) return false;
  if (!/^[A-Za-z0-9+/]+=*$/.test(flat)) return false;
  if (/[<>&]/.test(s.trim())) return false;
  return true;
}

function isLikelyDecodedTextContent(s: string): boolean {
  if (!s.trim()) return false;
  let good = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c === 9 || c === 10 || c === 13) {
      good++;
      continue;
    }
    if (c >= 32 && c <= 126) {
      good++;
      continue;
    }
    if (c >= 0x4e00 && c <= 0x9fff) {
      good++;
      continue;
    }
    if (c >= 0x3000 && c <= 0x303f) {
      good++;
      continue;
    }
    if (c > 127 && c < 0xfffd) {
      good++;
      continue;
    }
  }
  return good / Math.max(s.length, 1) >= 0.85;
}

/** 展示/空正文判断：兼容历史入库的未解码 base64（BODY[TEXT] 同步） */
export function decodeBase64BodyLoose(input: string): string | null {
  if (!looksLikeBase64Payload(input)) return null;
  try {
    const flat = input.replace(/\s/g, "");
    const bin = atob(flat);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (!isLikelyDecodedTextContent(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function isUndecodedBase64Body(text: string | null | undefined): boolean {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  return decodeBase64BodyLoose(raw) !== null;
}

const MIME_PART_HEADER_LINE_RE =
  /^(content-type|content-transfer-encoding|content-disposition|content-id|content-description|mime-version)\s*:/i;

/** 与 Edge mime-parse 同步：MIME 头折行续行或截断后的参数行 */
const MIME_PARAM_LINE_RE =
  /^(charset|boundary|name|filename|format|type|protocol|micalg|report-type|access-type)\s*=/i;

const MIME_MEDIA_TYPE_LINE_RE =
  /^(?:multipart|text|image|application|message|audio|video)\/[\w.+-]+(?:\s*;[\s\S]*)?$/i;

function isMimeMetadataLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (MIME_PART_HEADER_LINE_RE.test(t)) return true;
  if (MIME_PARAM_LINE_RE.test(t)) return true;
  if (MIME_MEDIA_TYPE_LINE_RE.test(t)) return true;
  return false;
}

function hasStrongMimeMetadataSignal(lines: string[]): boolean {
  return lines.some((line) => {
    const t = line.trim();
    if (MIME_PART_HEADER_LINE_RE.test(t)) return true;
    if (/^charset\s*=/i.test(t)) return true;
    if (/^boundary\s*=/i.test(t)) return true;
    if (MIME_MEDIA_TYPE_LINE_RE.test(t)) return true;
    return false;
  });
}

/** 与 Edge mime-parse 同步：仅 MIME 头/元数据、无实质正文 */
export function isMimeHeadersOnlyBody(text: string | null | undefined): boolean {
  const s = String(text ?? "").trim();
  if (!s || s.length > 2000) return false;
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > 12) return false;
  if (!lines.every(isMimeMetadataLine)) return false;
  return hasStrongMimeMetadataSignal(lines);
}

/** 仅手机默认签名（无实质客户正文）。与 Edge mime-parse 对齐。 */
export function isMobileSignatureOnlyText(text: string | null | undefined): boolean {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 80) return false;
  return /^(sent from my (iphone|ipad|ipod)|sent from mail for windows|get outlook for (ios|android)|envoy[eé] de mon iphone|von meinem iphone gesendet|iphoneから送信)\.?$/i.test(
    t,
  );
}

export function hasReadableEmailBodyForDisplay(
  bodyText: string | null | undefined,
  bodyHtml: string | null | undefined,
): boolean {
  const text = String(bodyText ?? "").trim();
  const html = String(bodyHtml ?? "").trim();
  if (
    html &&
    !isUndecodedBase64Body(html) &&
    !isMimeHeadersOnlyBody(html) &&
    !isMobileSignatureOnlyText(htmlBodyVisibleText(html))
  ) {
    return true;
  }
  if (
    text &&
    !isUndecodedBase64Body(text) &&
    !isMimeHeadersOnlyBody(text) &&
    !isMobileSignatureOnlyText(text)
  ) {
    return true;
  }
  return false;
}

function looksLikeQuotedPrintable(s: string): boolean {
  return /=([0-9A-Fa-f]{2})(?![0-9A-Fa-f])/.test(s) || /=\r?\n/.test(s);
}

/** 展示前解码 quoted-printable（兼容历史入库脏数据） */
export function decodeQuotedPrintableLoose(input: string): string {
  if (!looksLikeQuotedPrintable(input)) return input;
  const buf: number[] = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] === "=") {
      if (i + 2 < input.length) {
        if (input[i + 1] === "\r" && input[i + 2] === "\n") {
          i += 2;
          continue;
        }
        if (input[i + 1] === "\n") {
          i += 1;
          continue;
        }
        const hex = input.substring(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          buf.push(parseInt(hex, 16));
          i += 2;
          continue;
        }
      }
    } else if (input[i] !== "\r" && input[i] !== "\n") {
      buf.push(input.charCodeAt(i));
    }
  }
  try {
    return new TextDecoder("utf-8").decode(new Uint8Array(buf));
  } catch {
    return input;
  }
}

/**
 * 剥离泄漏进正文的 CSS（Froala/编辑器 &lt;style&gt; 内容进 text/plain，或标签被剥落后规则残留）。
 * 只清理 style 块与「连续规则块」前缀，不碰正文里偶尔出现的单个大括号。
 */
export function stripCssPollutionFromEmailText(input: string): string {
  let s = String(input ?? "");
  if (!s) return "";

  s = s
    .replace(/<\s*style\b[\s\S]*?<\s*\/\s*style\s*>/gi, "\n")
    .replace(/&lt;\s*style\b[\s\S]*?&lt;\s*\/\s*style\s*&gt;/gi, "\n");

  // 选择器 { 声明 } — 常见 .class / #id / @media / tag.class
  const ruleChunk =
    /(?:\/\*[\s\S]*?\*\/\s*)*(?:@[-\w]+(?:\s+[^{]+)?|(?:[.#]?[-\w]+(?:\.[-\w]+)*(?::+[-\w()]+)?(?:\s*,\s*[.#]?[-\w]+(?:\.[-\w]+)*(?::+[-\w()]+)?)*)\s*\{[^{}]*\})/;
  const leadingRules = new RegExp(`^(?:\\s*(?:${ruleChunk.source}))+\\s*`, "i");

  // 正文开头或 HTML 标签前的孤立 CSS 规则链
  for (let i = 0; i < 8; i++) {
    const before = s;
    s = s.replace(leadingRules, "");
    if (s === before) break;
  }

  return s.replace(/^\s+/, "");
}

/** 展示前移除会污染全局页面的 HTML 标签（邮件正文常含全局 a/color 规则） */
export function sanitizeEmailHtmlForDisplay(html: string): string {
  let out = html
    .replace(/<\s*script\b[\s\S]*?<\s*\/\s*script\s*>/gi, "")
    .replace(/<\s*style\b[\s\S]*?<\s*\/\s*style\s*>/gi, "")
    .replace(/&lt;\s*style\b[\s\S]*?&lt;\s*\/\s*style\s*&gt;/gi, "")
    .replace(/<\s*link\b[^>]*\brel=["']?stylesheet["']?[^>]*>/gi, "");

  const firstTag = out.search(/</);
  if (firstTag < 0) {
    return stripCssPollutionFromEmailText(out);
  }
  if (firstTag > 0) {
    const head = stripCssPollutionFromEmailText(out.slice(0, firstTag));
    out = `${head}${out.slice(firstTag)}`;
  }
  return out;
}

/** 从 HTML 提取可见纯文本（用于判断 Word 空壳、回退展示） */
export function htmlBodyVisibleText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/div|\/tr|\/li)\b[^>]*>/gi, "\n")
    .replace(/<\s*(script|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const OUTLOOK_HTML_SHELL_RE =
  /xmlns:v="urn:schemas-microsoft-com:vml"|Microsoft Word|mso-|urn:schemas-microsoft-com:office/i;

/** Outlook/Word 导出的 HTML 常仅有样式壳、几乎无可读正文 */
export function isOutlookEmptyHtmlShell(html: string | null | undefined): boolean {
  const raw = html?.trim() ?? "";
  if (!raw || !OUTLOOK_HTML_SHELL_RE.test(raw)) return false;
  return htmlBodyVisibleText(raw).length < 120;
}

function normalizeBodyCompareSnippet(s: string): string {
  return s
    .replace(/[*_~`]/g, "")
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Gmail 导出的 HTML（含签名、引用块） */
export function isGmailStructuredHtml(html: string | null | undefined): boolean {
  const h = html?.trim() ?? "";
  if (!h) return false;
  return /gmail_quote|gmail_signature|gmail_attr|class=["'][^"']*gmail_/i.test(h);
}

/** body_text 有实质内容但 HTML 可见区未包含其开头（Word 空壳 / 内嵌图邮件常见） */
export function plainTextNotRepresentedInHtml(
  plain: string,
  html: string | null | undefined,
): boolean {
  // 先去掉泄漏的 CSS，避免 .fr-emoticon / background-repeat 等伪词误判「HTML 不含正文」
  const p = stripCssPollutionFromEmailText(plain).trim();
  if (p.length < 20) return false;
  if (isGmailStructuredHtml(html)) return false;
  const hVis = html?.trim() ? htmlBodyVisibleText(html) : "";
  if (!hVis) return true;
  const words = normalizeBodyCompareSnippet(p)
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 10);
  if (words.length < 3) return false;
  const hNorm = normalizeBodyCompareSnippet(hVis);
  const matched = words.filter((w) => hNorm.includes(w)).length;
  return matched < Math.ceil(words.length * 0.6);
}

/** Gmail 纯文本单段 + > 引用（同步时换行被抹掉） */
export function isGmailCollapsedPlainBody(s: string): boolean {
  const newlineCount = (s.match(/\n/g) ?? []).length;
  return (
    newlineCount < 8 &&
    /On\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),.+wrote:/i.test(s) &&
    />/.test(s)
  );
}

/** 恢复 Gmail 压扁纯文本的换行与引用层级 */
export function formatGmailCollapsedPlainBody(text: string): string {
  let s = decodePlainTextEntities(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  s = s.replace(/([.a-z]{2,})(On\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),)/gi, "$1\n\n$2");
  s = s.replace(/(wrote:)(>+)/gi, "$1\n$2 ");
  s = s.replace(/([.!?])\s*(>+)/g, "$1\n$2 ");
  s = s.replace(/(>+)\s*(Original:)/gi, "\n\n$2");
  s = s.replace(/(>+)\s*(On\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),)/gi, "\n\n$2");
  s = s.replace(/(>+)\s*(\d+\.)\s+/g, "$1\n$2 ");
  s = s.replace(/(>+)\s*(-\s*From)/gi, "$1\n$2");
  s = s.replace(/\*([^*\n]{1,120})\*/g, "$1");
  s = s.replace(/([^\n])(📧|🌐|📎)/g, "$1\n$2");
  s = s.replace(/\s+(>+)\s+/g, "\n$1 ");
  s = s.replace(/[ \t]{2,}/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function stripGmailQuoteLinePrefixes(block: string): string {
  return block
    .split("\n")
    .map((line) => line.replace(/^(?:>\s*)+/, "").trimEnd())
    .join("\n");
}

/**
 * 解码纯文本中的 HTML 实体；勿用 innerHTML，否则 `<user@host>` 会被当成标签吞掉。
 */
export function decodePlainTextEntities(text: string): string {
  if (!text) return "";
  return text
    .replace(/&nbsp;/gi, "\u00A0")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

const EMAIL_HEADER_NAMES = [
  "From",
  "Sent",
  "Reply-To",
  "To",
  "Cc",
  "Bcc",
  "Subject",
  "Date",
  "Importance",
] as const;

function escapeHtmlForEmailDisplay(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 历史同步/纯文本 MIME 常把换行压成空格；恢复邮件头、段落与引用块换行。
 */
export function formatPlainTextEmailForDisplay(text: string): string {
  let s = decodePlainTextEntities(stripCssPollutionFromEmailText(text))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (!s.trim()) return "";

  if (isGmailCollapsedPlainBody(s)) {
    s = formatGmailCollapsedPlainBody(s);
    const afterGmailNl = (s.match(/\n/g) ?? []).length;
    if (afterGmailNl >= 6) {
      return s.replace(/\n{3,}/g, "\n\n").trim();
    }
  }

  const newlineCount = (s.match(/\n/g) ?? []).length;
  if (newlineCount >= 8) {
    return s.replace(/\t+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  s = s.replace(/\t+/g, "\n").replace(/\u00a0/g, " ");

  for (const name of EMAIL_HEADER_NAMES) {
    s = s.replace(
      new RegExp(`(?<!\\n)(?<![\\n\\r])\\s{2,}(${name}\\s*[：:])`, "gi"),
      "\n\n$1",
    );
  }

  s = s.replace(/([ap]\.?\s*m\.?)(To\s*[：:])/gi, "$1\n$2");
  s = s.replace(/(<[^>]+>)\s+(Sent\s*[：:])/gi, "$1\n$2");
  s = s.replace(/(<[^>]+>)\s+(To\s*[：:])/gi, "$1\n$2");
  s = s.replace(/(>)(Subject\s*[：:])/gi, "$1\n$2");
  s = s.replace(/(>)(Sent\s*[：:])/gi, "$1\n$2");
  s = s.replace(/(>)(To\s*[：:])/gi, "$1\n$2");
  s = s.replace(/(>)(From\s*[：:])/gi, "$1\n$2");
  s = s.replace(/(@[^\s>]+)\s+(Sent\s*[：:])/gi, "$1\n$2");

  s = s.replace(/(Subject\s*:[^\n]{0,240}?)(Dear\s+)/gi, "$1\n\n$2");
  s = s.replace(/(Subject\s*:[^\n]{0,240}?)(Greetings,)/gi, "$1\n\n$2");
  s = s.replace(/(Subject\s*:[^\n]{0,240}?)(Hello[\s,])/gi, "$1\n\n$2");
  s = s.replace(/(Subject\s*:[^\n]{0,240}?)(Hi[\s,])/gi, "$1\n\n$2");
  s = s.replace(/(Importance\s*:\s*High\s*)(Greetings,)/gi, "$1\n\n$2");
  s = s.replace(/(Importance\s*:\s*High\s*)(Dear\s+)/gi, "$1\n\n$2");

  s = s.replace(/(customer,)(Thank\s+)/gi, "$1\n\n$2");
  s = s.replace(/(customer,)(I\s+)/gi, "$1\n\n$2");
  s = s.replace(/(\?)(Thank\s+)/g, "$1\n\n$2");
  s = s.replace(/(reply\.)(\s*)(SEDETA)/gi, "$1\n\n$3");
  s = s.replace(/(support\.)(\s*)(Looking)/gi, "$1\n\n$3");
  s = s.replace(/(us\.)(I\s+)/gi, "$1\n$2");
  s = s.replace(/(part)(Importance\s*[：:])/gi, "$1\n$2");
  s = s.replace(/(\.com)\s+(Subject\s*[：:])/gi, "$1\n$2");
  s = s.replace(/(Service)(service@)/gi, "$1\n$2");

  s = s.replace(/\s*(Original\s*:\s*)/gi, "\n\n$1\n");
  s = s.replace(/\*+\s*(From\s*[：:])/gi, "\n$1");
  s = s.replace(/\*+\s*(Date\s*[：:])/gi, "\n$1");
  s = s.replace(/\*+\s*(To\s*[：:])/gi, "\n$1");
  s = s.replace(/\*+\s*(Cc\s*[：:])/gi, "\n$1");
  s = s.replace(/\*+\s*(Subject\s*[：:])/gi, "\n$1");

  s = s.replace(/\. ([A-Z][a-z]{3,})/g, ".\n$1");

  s = s.replace(/[ \t]{2,}/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

export function splitPlainEmailTopAndQuoted(formatted: string): {
  top: string;
  quoted: string | null;
} {
  const gmailWrote = formatted.search(
    /\n\nOn\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),[\s\S]{8,220}?wrote:\s*(?:\n|$)/i,
  );
  if (gmailWrote > 6) {
    return {
      top: formatted.slice(0, gmailWrote).trim(),
      quoted: formatted.slice(gmailWrote).trim(),
    };
  }
  const gmailWroteSingle = formatted.search(
    /\nOn\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),[\s\S]{8,220}?wrote:\s*\n/i,
  );
  if (gmailWroteSingle > 6) {
    return {
      top: formatted.slice(0, gmailWroteSingle).trim(),
      quoted: formatted.slice(gmailWroteSingle).trim(),
    };
  }
  const idx = formatted.search(/\n\nFrom\s*[：:]/i);
  if (idx > 12) {
    return {
      top: formatted.slice(0, idx).trim(),
      quoted: formatted.slice(idx).trim(),
    };
  }
  return { top: formatted, quoted: null };
}

/** 将排版后的纯文本转为安全 HTML（引用块样式接近官方邮箱） */
export function plainTextEmailToDisplayHtml(formatted: string): string {
  const { top, quoted } = splitPlainEmailTopAndQuoted(formatted);
  const toBr = (block: string) =>
    escapeHtmlForEmailDisplay(stripGmailQuoteLinePrefixes(block)).replace(/\n/g, "<br>\n");

  if (quoted) {
    const attrMatch = quoted.match(
      /^On\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),[\s\S]{8,220}?wrote:\s*/i,
    );
    if (attrMatch) {
      const attr = attrMatch[0]!.trim();
      const body = quoted.slice(attrMatch[0]!.length).trim();
      return (
        `<div class="email-plain-main">${toBr(top)}</div>` +
        `<div class="email-gmail-attr text-muted-foreground text-xs mt-3 mb-1">${escapeHtmlForEmailDisplay(attr)}</div>` +
        `<blockquote class="email-plain-quote">${toBr(body)}</blockquote>`
      );
    }
    return (
      `<div class="email-plain-main">${toBr(top)}</div>` +
      `<blockquote class="email-plain-quote">${toBr(quoted)}</blockquote>`
    );
  }
  return `<div class="email-plain-main">${toBr(formatted)}</div>`;
}

/**
 * 选择应在正文区渲染的内容：避免 body_html 为 Word 空壳时盖住 body_text。
 */
function readableStoredBodyText(raw: string | null | undefined): string {
  const t = String(raw ?? "").trim();
  if (!t || isMimeHeadersOnlyBody(t) || isUndecodedBase64Body(t)) return "";
  return t;
}

export function pickRenderableEmailBody(
  bodyText: string | null | undefined,
  bodyHtml: string | null | undefined,
): { text: string; html: string | null } {
  const n = normalizeEmailBodyForDisplay(bodyText, bodyHtml);
  const rawTextFallback = readableStoredBodyText(bodyText) || n.text.trim();
  const textFallback =
    stripCssPollutionFromEmailText(rawTextFallback).trim() ||
    stripCssPollutionFromEmailText(n.text).trim();
  const visibleHtml = n.html ? htmlBodyVisibleText(n.html) : "";

  if (!n.html || !looksLikeHtmlEmailContent(n.html)) {
    return { text: textFallback || n.text, html: null };
  }

  if (isGmailStructuredHtml(n.html) && htmlBodyVisibleText(n.html).length > 15) {
    return {
      text: stripCssPollutionFromEmailText(n.text || textFallback).trim(),
      html: n.html,
    };
  }

  const htmlNearlyEmpty =
    visibleHtml.length < 48 && textFallback.length > visibleHtml.length + 20;
  const outlookShell =
    isOutlookEmptyHtmlShell(n.html) && textFallback.length > 40;

  if (htmlNearlyEmpty || outlookShell) {
    return { text: textFallback || visibleHtml || n.text, html: null };
  }

  if (plainTextNotRepresentedInHtml(rawTextFallback, n.html)) {
    return { text: textFallback, html: null };
  }

  if (visibleHtml.length > 0) {
    return {
      text: stripCssPollutionFromEmailText(n.text || textFallback).trim(),
      html: n.html,
    };
  }

  return { text: textFallback || n.text, html: null };
}

/** 判断字符串是否像 HTML 邮件正文（Gmail 等常把 HTML 落在 body_text） */
export function looksLikeHtmlEmailContent(s: string): boolean {
  if (!s?.trim()) return false;
  return /<(html|head|body|div|p|table|tr|td|th|span|a|br|img|ul|ol|li|h[1-6]|blockquote|strong|em|pre|code|hr|style|meta|font|center)\b[\s>]/i.test(
    s,
  );
}

/** 将 body_text/body_html 规范为可展示内容（解码 QP、优先 HTML） */
export function normalizeEmailBodyForDisplay(
  bodyText: string | null | undefined,
  bodyHtml: string | null | undefined,
): { text: string; html: string | null } {
  let html = bodyHtml?.trim() ? bodyHtml.trim() : null;
  let text = bodyText?.trim() ?? "";

  if (isMimeHeadersOnlyBody(text)) text = "";
  if (isMimeHeadersOnlyBody(html)) html = null;

  if (html && isUndecodedBase64Body(html)) {
    html = decodeBase64BodyLoose(html);
  }
  if (text && isUndecodedBase64Body(text)) {
    text = decodeBase64BodyLoose(text) ?? text;
  }

  if (html && looksLikeQuotedPrintable(html)) {
    html = decodeQuotedPrintableLoose(html);
  }
  if (!html && text && looksLikeQuotedPrintable(text)) {
    const decoded = decodeQuotedPrintableLoose(text);
    if (looksLikeHtmlEmailContent(decoded)) {
      html = decoded;
      text = htmlBodyVisibleText(decoded);
    } else {
      text = decoded;
    }
  }
  if (!html && text && looksLikeHtmlEmailContent(text)) {
    html = text;
    text = htmlBodyVisibleText(text);
  }
  if (html && !text) {
    text = htmlBodyVisibleText(html);
  }
  return { text, html };
}

/** 供 EmailBody 单字段入参使用 */
export function normalizeEmailBodyContent(content: string | null | undefined): {
  text: string;
  html: string | null;
} {
  const raw = content?.trim() ?? "";
  if (!raw) return { text: "", html: null };
  return normalizeEmailBodyForDisplay(raw, null);
}

export const BODY_REPAIR_COOLDOWN_MS = 8 * 60 * 1000;

export type BodyRepairUiStatus =
  | "idle"
  | "quick"
  | "queued"
  | "not_found_retrying"
  | "failed"
  | "failed_terminal"
  | "done";

export type RepairEmailBodyResult =
  | { ok: true; repaired: true }
  | { ok: true; repaired: false; skipped: true }
  | { ok: true; repaired: false; queued: true; queueReason?: string }
  | { ok: false; errorMessage: string; terminal?: boolean };

type SyncRepairRow = {
  error?: string;
  skipped?: boolean;
  repaired?: number;
  queued?: boolean;
  queue_reason?: string;
  terminal?: boolean;
};

/** 将 sync-mailbox repair_email_id 单行结果映射为前端类型 */
export function mapSyncRepairRow(row: SyncRepairRow | undefined): RepairEmailBodyResult {
  if (!row) {
    return { ok: false, errorMessage: "未获取到补正文结果" };
  }
  if (row.queued) {
    return {
      ok: true,
      repaired: false,
      queued: true,
      queueReason: row.queue_reason,
    };
  }
  if (row.skipped) {
    return { ok: true, repaired: false, skipped: true };
  }
  if ((row.repaired ?? 0) > 0) {
    return { ok: true, repaired: true };
  }
  if (row.error) {
    return {
      ok: false,
      errorMessage: row.error,
      terminal: row.terminal === true,
    };
  }
  return { ok: false, errorMessage: "未能补拉正文" };
}

function isWorkerCancelledMessage(msg: string): boolean {
  return /WorkerRequestCancelled|request has been cancelled/i.test(msg);
}

function isUidNotFoundMessage(msg: string): boolean {
  return /skip_no_uid|uid_not_found|Message-ID 未命中|无法在邮箱中找到/i.test(msg);
}

/** 从 IMAP 为单封已入库邮件补拉正文（轻量限时，失败自动入队） */
export async function invokeRepairEmailBody(emailId: string): Promise<RepairEmailBodyResult> {
  const { data, error } = await supabase.functions.invoke("sync-mailbox", {
    body: { repair_email_id: emailId },
  });
  if (error) {
    const raw = await formatFunctionsInvokeError(error);
    if (isWorkerCancelledMessage(raw)) {
      return {
        ok: true,
        repaired: false,
        queued: true,
        queueReason: "worker_request_cancelled",
      };
    }
    return { ok: false, errorMessage: raw };
  }
  if (data?.error) {
    const msg = String(data.error);
    if (isWorkerCancelledMessage(msg)) {
      return { ok: true, repaired: false, queued: true, queueReason: "worker_request_cancelled" };
    }
    return { ok: false, errorMessage: msg };
  }
  return mapSyncRepairRow(data?.results?.[0] as SyncRepairRow | undefined);
}

/** 有正文但未分析时补偿触发 process-email */
export async function invokeProcessEmailAfterBodyRepair(
  emailId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke("process-email", {
    body: { email_id: emailId, after_body_repair: true },
  });
  if (error) {
    return { ok: false, error: await formatFunctionsInvokeError(error) };
  }
  if (data?.error) {
    return { ok: false, error: String(data.error) };
  }
  return { ok: true };
}

export type BodyRepairTaskRow = {
  status: string;
  last_error?: string | null;
  repaired_at?: string | null;
  post_processed_at?: string | null;
  next_run_at?: string | null;
  attempt_count?: number | null;
};

/** 由任务行推导 UI 状态 */
export function deriveBodyRepairUiStatusFromTask(
  task: BodyRepairTaskRow | null,
): BodyRepairUiStatus {
  if (!task) return "idle";
  if (task.status === "failed") return "failed_terminal";
  if (task.status === "resolved" || task.status === "skipped") return "done";
  if (task.status === "pending" || task.status === "running") {
    if (isUidNotFoundMessage(task.last_error ?? "")) return "not_found_retrying";
    return "queued";
  }
  return "idle";
}

/** 查询后台正文补拉任务状态（员工 RLS 只读） */
export async function fetchBodyRepairTaskStatus(
  emailId: string,
): Promise<BodyRepairTaskRow | null> {
  const { data, error } = await supabase
    .from("email_body_repair_tasks")
    .select("status, last_error, repaired_at, post_processed_at, next_run_at, attempt_count")
    .eq("email_id", emailId)
    .maybeSingle();
  if (error) {
    console.warn("[fetchBodyRepairTaskStatus]", error.message);
    return null;
  }
  return data as BodyRepairTaskRow | null;
}

export function formatBodyRepairTaskHint(task: BodyRepairTaskRow | null): string | null {
  if (!task) return null;
  if (task.status === "failed") {
    return task.last_error ?? "补拉失败，请检查邮箱中是否仍存在该邮件";
  }
  if (task.status === "pending" || task.status === "running") {
    const parts: string[] = ["后台约每 3 分钟处理"];
    if (task.attempt_count != null && task.attempt_count > 0) {
      parts.push(`第 ${task.attempt_count} 次尝试`);
    }
    if (isUidNotFoundMessage(task.last_error ?? "")) {
      parts.push("正在重新定位原邮件");
    }
    return parts.join(" · ");
  }
  return null;
}

export type AttachmentRepairTaskRow = BodyRepairTaskRow;

export async function fetchAttachmentRepairTaskStatus(
  emailId: string,
): Promise<AttachmentRepairTaskRow | null> {
  const { data, error } = await supabase
    .from("email_attachment_repair_tasks")
    .select("status, last_error, repaired_at, next_run_at, attempt_count")
    .eq("email_id", emailId)
    .maybeSingle();
  if (error) {
    console.warn("[fetchAttachmentRepairTaskStatus]", error.message);
    return null;
  }
  return data as AttachmentRepairTaskRow | null;
}

export function formatAttachmentRepairTaskHint(task: AttachmentRepairTaskRow | null): string | null {
  if (!task) return null;
  if (task.status === "failed") {
    return task.last_error ?? "附件补拉失败，可在官方邮箱确认后重试";
  }
  if (task.status === "pending" || task.status === "running") {
    const parts: string[] = ["附件后台补拉约每 5 分钟处理"];
    if (task.attempt_count != null && task.attempt_count > 0) {
      parts.push(`第 ${task.attempt_count} 次尝试`);
    }
    return parts.join(" · ");
  }
  return null;
}
