/**
 * Recursive MIME parsing for Edge (Deno): bodies (multipart/alternative, mixed)
 * and binary attachment leaves. RFC-ish boundary splitting; not a full mail parser.
 */

export interface MimeAttachmentPart {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface ParseMimeResult {
  bodyText: string;
  bodyHtml: string | null;
  attachments: MimeAttachmentPart[];
}

const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Strip outer RFC822 headers when present; keep raw if already a MIME fragment. */
export function mimePayloadOnly(raw: string): string {
  const s = raw.trimStart();
  const firstLine = s.split(/\r?\n/)[0] ?? "";
  if (/^--[^\s\r\n]+/.test(firstLine) && !/^[\w-]+:\s/i.test(firstLine)) {
    return raw.trim();
  }
  const m = /\r?\n\r?\n/.exec(raw);
  if (!m) return raw.trim();
  const heads = raw.slice(0, m.index);
  if (/^content-type:/im.test(heads) || /^mime-version:/im.test(heads) || /^from:/im.test(heads)) {
    return raw.slice(m.index + m[0].length).trimStart();
  }
  return raw.trim();
}

function unfoldHeaders(block: string): string {
  return block.replace(/\r?\n[\t ]+/g, " ");
}

export function splitHeadersBody(part: string): { headers: string; body: string } {
  const p = part.replace(/^\r?\n/, "").trimStart();
  const m = /\r?\n\r?\n/.exec(p);
  if (!m) return { headers: "", body: p };
  return {
    headers: p.slice(0, m.index),
    body: p.slice(m.index + m[0].length).replace(/\r?\n$/, "").trimEnd(),
  };
}

function headerParam(headers: string, name: string): string | null {
  const unfolded = unfoldHeaders(headers);
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[;\\s])${esc}\\s*=\\s*("([^"]*)"|'([^']*)'|([^;\\s]+))`, "i");
  const m = unfolded.match(re);
  if (!m) return null;
  return (m[2] ?? m[3] ?? m[4] ?? "").trim() || null;
}

/** Content-Type 上的 name=（避免匹配到 filename= 中的子串 "name"） */
function contentTypeNameParam(headers: string): string | null {
  const unfolded = unfoldHeaders(headers);
  const m = unfolded.match(
    /(?:^|[;\s])name\s*=\s*("([^"]*)"|'([^']*)'|([^;\s]+))/i,
  );
  if (!m) return null;
  return (m[2] ?? m[3] ?? m[4] ?? "").trim() || null;
}

function decodeMimeWordsInFilename(s: string): string {
  if (!s || !/=\?/i.test(s)) return s;
  // 相邻编码词之间的空白应忽略
  let result = s.replace(/\?=\s+=\?/g, "?==?=");
  result = result.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/gi, (_m, charset: string, enc: string, data: string) => {
    try {
      if (enc.toUpperCase() === "B") {
        const bin = atob(data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder(charset).decode(bytes);
      } else {
        // Q 编码：=XX 是十六进制字节，_ 是空格
        const bytes: number[] = [];
        for (let i = 0; i < data.length; i++) {
          if (data[i] === "_") { bytes.push(0x20); }
          else if (data[i] === "=" && i + 2 < data.length) {
            bytes.push(parseInt(data.substring(i + 1, i + 3), 16));
            i += 2;
          } else { bytes.push(data.charCodeAt(i)); }
        }
        return new TextDecoder(charset).decode(new Uint8Array(bytes));
      }
    } catch {
      return _m;
    }
  });
  return result;
}

function parseFilenameStar(unfolded: string): string | null {
  const m = unfolded.match(/(?:^|[;\s])filename\*\s*=\s*([^;\r\n]+)/i);
  if (!m) return null;
  let v = m[1].trim().replace(/^["']|["']$/g, "");
  // 解析 charset'language'encoded-value 格式
  const rvParts = v.match(/^([^']*)'([^']*)'(.*)$/);
  if (rvParts) {
    const charset = rvParts[1] || "utf-8";
    v = rvParts[3];
    try {
      const decoded = decodeURIComponent(v);
      return decoded || null;
    } catch {
      try {
        // 回退：逐字节 percent-decode 后用指定 charset 解码
        const bytes = v.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        return new TextDecoder(charset).decode(new TextEncoder().encode(bytes)) || null;
      } catch {
        return v || null;
      }
    }
  }
  if (/^UTF-8''/i.test(v)) v = v.replace(/^UTF-8''/i, "");
  try {
    return decodeURIComponent(v);
  } catch {
    return v || null;
  }
}

/** RFC 2231 续行参数：filename*0*=UTF-8''part1; filename*1*=part2 */
function parseFilenameRfc2231Continuation(unfolded: string): string | null {
  const parts: Array<{ idx: number; encoded: boolean; value: string }> = [];
  const re = /(?:^|[;\s])filename\*(\d+)(\*?)\s*=\s*([^;\r\n]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(unfolded)) !== null) {
    const idx = parseInt(m[1], 10);
    const encoded = m[2] === "*";
    const value = m[3].trim().replace(/^["']|["']$/g, "");
    parts.push({ idx, encoded, value });
  }
  if (parts.length === 0) return null;
  parts.sort((a, b) => a.idx - b.idx);

  let charset = "utf-8";
  let combined = "";
  for (let i = 0; i < parts.length; i++) {
    let v = parts[i].value;
    if (i === 0 && parts[i].encoded) {
      const head = v.match(/^([^']*)'([^']*)'(.*)$/);
      if (head) {
        charset = head[1] || "utf-8";
        v = head[3];
      }
    }
    if (parts[i].encoded) {
      try {
        // 先尝试 UTF-8 percent-decode；若失败则按声明 charset 逐字节解码
        combined += decodeURIComponent(v);
      } catch {
        try {
          const rawBytes = v.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
          const u8 = new Uint8Array(Array.from(rawBytes).map((c) => c.charCodeAt(0)));
          combined += new TextDecoder(charset).decode(u8);
        } catch { combined += v; }
      }
    } else {
      combined += v;
    }
  }
  return combined || null;
}

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/pjpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "image/tiff": ".tiff",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/x-zip-compressed": ".zip",
  "application/x-rar-compressed": ".rar",
  "application/vnd.rar": ".rar",
  "application/x-7z-compressed": ".7z",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.ms-powerpoint": ".ppt",
  "text/csv": ".csv",
  "text/plain": ".txt",
  "text/html": ".html",
  "application/json": ".json",
  "application/xml": ".xml",
  "text/xml": ".xml",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
};

function extensionFromMime(mime: string): string {
  const m = (mime || "").split(";")[0].trim().toLowerCase();
  return MIME_TO_EXT[m] ?? "";
}

/** 从 Content-Disposition / Content-Type 尽量取出附件文件名 */
function extractAttachmentFilename(headers: string): string | null {
  const unfolded = unfoldHeaders(headers);
  let raw =
    parseFilenameStar(unfolded) ||            // filename*=charset''...
    parseFilenameRfc2231Continuation(unfolded) || // filename*0*=...; filename*1*=...
    headerParam(unfolded, "filename") ||       // filename="..."
    contentTypeNameParam(headers);             // name="..."
  if (!raw) return null;
  raw = decodeMimeWordsInFilename(raw.trim().replace(/^["']|["']$/g, ""));
  return raw.trim() || null;
}

function getBoundary(contentTypeValue: string): string | null {
  const m = unfoldHeaders(contentTypeValue).match(/boundary\s*=\s*("([^"]+)"|([^;\s]+))/i);
  if (!m) return null;
  return (m[2] ?? m[3] ?? "").trim();
}

function getMainMediaType(headers: string): { full: string; main: string; subtype: string } {
  const unfolded = unfoldHeaders(headers);
  const m = unfolded.match(/content-type:\s*([\w-]+\/[\w.+-]+)/i);
  const full = (m?.[1] ?? "application/octet-stream").toLowerCase();
  const [main, sub = ""] = full.split("/");
  return { full, main, subtype: sub };
}

function getContentTransferEncoding(headers: string): string {
  const m = unfoldHeaders(headers).match(/content-transfer-encoding:\s*(\S+)/i);
  return (m?.[1] ?? "7bit").toLowerCase();
}

function getDisposition(headers: string): { type: string | null; filename: string | null } {
  const unfolded = unfoldHeaders(headers);
  const m = unfolded.match(/content-disposition:\s*([^;\r\n]+)/i);
  const type = m?.[1]?.trim().toLowerCase() ?? null;
  const filename = extractAttachmentFilename(headers);
  return { type, filename };
}

/** 仅把 Content-Disposition: attachment 视为附件；避免 text/html; name=… 被误判为非正文 */
function hasAttachmentDisposition(headers: string): boolean {
  return /content-disposition:\s*attachment/i.test(unfoldHeaders(headers));
}

/** inline 或未声明 disposition 的 text/plain|html 一律视为正文，不因 Content-Type name= 当附件 */
function shouldTreatTextPartAsAttachment(headers: string): boolean {
  return hasAttachmentDisposition(headers);
}

function looksLikeQuotedPrintable(s: string): boolean {
  return /=([0-9A-Fa-f]{2})(?![0-9A-Fa-f])/.test(s) || /=\r?\n/.test(s);
}

/** 无 MIME 头时的 quoted-printable 解码（Shopify / BODY[TEXT] 片段） */
function decodeQuotedPrintableLoose(input: string): string {
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

/** 取 base64 行直到 MIME boundary，避免把 epilogue/--boundary 喂进 atob */
function joinBase64Payload(body: string): string {
  const lines = body.split(/\r?\n/);
  const chunks: string[] = [];
  for (const line of lines) {
    const t = line.replace(/\s/g, "");
    if (!t) continue;
    if (t.startsWith("--")) break;
    if (/^[A-Za-z0-9+/]+=*$/.test(t)) chunks.push(t);
    else if (chunks.length > 0) break;
  }
  if (chunks.length > 0) return chunks.join("");
  let flat = body.replace(/\s/g, "");
  const dash = flat.indexOf("--");
  if (dash > 0) flat = flat.slice(0, dash);
  return flat;
}

function decodeBodyToBytes(headers: string, body: string): Uint8Array {
  const charset = headers.match(/charset=(["']?)([\w-]+)\1/i)?.[2] ?? "utf-8";
  const cte = getContentTransferEncoding(headers);
  try {
    if (cte === "base64") {
      const b = joinBase64Payload(body);
      const bin = atob(b);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    if (cte === "quoted-printable") {
      const buf: number[] = [];
      for (let i = 0; i < body.length; i++) {
        if (body[i] === "=") {
          if (i + 2 < body.length) {
            if (body[i + 1] === "\r" && body[i + 2] === "\n") {
              i += 2;
              continue;
            }
            if (body[i + 1] === "\n") {
              i += 1;
              continue;
            }
            buf.push(parseInt(body.substring(i + 1, i + 3), 16));
            i += 2;
          }
        } else if (body[i] !== "\r" && body[i] !== "\n") {
          buf.push(body.charCodeAt(i));
        }
      }
      return new Uint8Array(buf);
    }
    return new TextEncoder().encode(body);
  } catch {
    return new TextEncoder().encode(body);
  }
}

function decodeBodyToText(headers: string, body: string): string {
  const bytes = decodeBodyToBytes(headers, body);
  const charset = headers.match(/charset=(["']?)([\w-]+)\1/i)?.[2] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function decodeHtmlEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
  };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, entity) => {
    const e = String(entity).toLowerCase();
    if (e.startsWith("#x")) {
      const n = parseInt(e.slice(2), 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    if (e.startsWith("#")) {
      const n = parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return named[e] ?? m;
  });
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<\s*(br|\/p|\/div|\/tr|\/li)\b[^>]*>/gi, "\n")
      .replace(/<\s*(script|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split multipart body into child part strings (each may start with headers). */
export function splitByBoundary(body: string, boundaryToken: string): string[] {
  const b = boundaryToken.replace(/^["']|["']$/g, "").trim();
  if (!b) return [];
  let work = body.replace(/^\r?\n/, "");
  if (work.startsWith(`--${b}`)) {
    work = `\r\n${work}`;
  }
  const delim = new RegExp(`\\r?\\n--${escapeRe(b)}(?!--)(?=\\r?\\n|$)`, "g");
  const parts: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = delim.exec(work)) !== null) {
    if (m.index > last) {
      parts.push(work.slice(last, m.index));
    }
    last = delim.lastIndex;
  }
  if (last < work.length) parts.push(work.slice(last));
  const closeRe = new RegExp(`\\r?\\n--${escapeRe(b)}--\\s*$`, "");
  return parts
    .map((p) => {
      let x = p.replace(/^\r?\n/, "").trimEnd();
      x = x.replace(closeRe, "");
      return x.trimEnd();
    })
    .filter((p) => p.length > 0);
}

function isBodyTextLeaf(headers: string): boolean {
  const { main, subtype } = getMainMediaType(headers);
  if (main !== "text") return false;
  if (subtype !== "plain" && subtype !== "html") return false;
  if (hasAttachmentDisposition(headers)) return false;
  return true;
}

function safeFilename(name: string | null, contentType: string, index: number): string {
  const base = (name && name.trim()) || `attachment-${index + 1}`;
  let cleaned = base.replace(/[/\\]/g, "_").replace(/\0/g, "").slice(0, 200);
  if (!/\.[a-z0-9]{2,8}$/i.test(cleaned)) {
    const ext = extensionFromMime(contentType);
    if (ext) cleaned = `${cleaned}${ext}`;
  }
  return cleaned || `attachment-${index + 1}`;
}

function pickBestAlternative(plainParts: string[], htmlParts: string[]): { bodyText: string; bodyHtml: string | null } {
  const plain = plainParts.filter((p) => p.trim()).pop()?.trim() ?? "";
  const html = htmlParts.filter((p) => p.trim()).pop()?.trim() ?? null;
  let bodyText = plain;
  if (html) {
    const stripped = htmlToText(html);
    if (!bodyText && stripped) bodyText = stripped;
  }
  return { bodyText, bodyHtml: html || null };
}

function inferAnonymousMultipartSubtype(subs: string[]): "alternative" | "mixed" {
  if (subs.length < 2) return "mixed";
  let allTextOrNested = true;
  for (const s of subs) {
    const { headers } = splitHeadersBody(s.trim());
    if (!headers.trim()) {
      allTextOrNested = false;
      break;
    }
    const { main } = getMainMediaType(headers);
    if (main !== "text" && main !== "multipart") {
      allTextOrNested = false;
      break;
    }
  }
  if (allTextOrNested && subs.length === 2) return "alternative";
  return "mixed";
}

/** Parse one MIME part (headers + body or nested fragment). */
export function parseMimePart(part: string, options?: { forceAttachment?: boolean }): ParseMimeResult {
  const empty: ParseMimeResult = { bodyText: "", bodyHtml: null, attachments: [] };
  const trimmed = part.replace(/^\r?\n/, "").trimStart();
  if (!trimmed) return empty;

  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
  if (/^--[^\s\r\n]+/.test(firstLine) && !/^[\w-]+:\s/i.test(firstLine)) {
    const token = firstLine.replace(/^--/, "");
    const subs = splitByBoundary(trimmed, token);
    if (subs.length === 0) return empty;
    const sub = inferAnonymousMultipartSubtype(subs);
    const fakeCt =
      sub === "alternative"
        ? `Content-Type: multipart/alternative; boundary="${token.replace(/"/g, "")}"`
        : `Content-Type: multipart/mixed; boundary="${token.replace(/"/g, "")}"`;
    return parseMimePart(`${fakeCt}\r\n\r\n${trimmed}`, options);
  }

  const { headers, body } = splitHeadersBody(trimmed);
  if (!headers.trim()) {
    // 无 MIME 头部：将全部内容作为纯文本回退，避免正文丢失
    const text = body.trim();
    return text ? { bodyText: text, bodyHtml: null, attachments: [] } : empty;
  }

  const ctLine = unfoldHeaders(headers).match(/content-type:\s*([^\r\n]+)/i)?.[1] ?? "";
  const boundary = getBoundary(ctLine);
  const { main, full } = getMainMediaType(headers);

  if (main === "multipart" && boundary) {
    const subs = splitByBoundary(body, boundary);
    const subtype = full.split("/")[1] ?? "";

    if (subtype === "alternative") {
      const plainParts: string[] = [];
      const htmlParts: string[] = [];
      let atts: MimeAttachmentPart[] = [];
      for (const sub of subs) {
        const r = parseMimePart(sub);
        if (r.bodyText) plainParts.push(r.bodyText);
        if (r.bodyHtml) htmlParts.push(r.bodyHtml);
        atts = atts.concat(r.attachments);
      }
      const best = pickBestAlternative(plainParts, htmlParts);
      return { bodyText: best.bodyText, bodyHtml: best.bodyHtml, attachments: atts };
    }

    if (subtype === "mixed" || subtype === "related") {
      if (subs.length === 0) return empty;
      const plainParts: string[] = [];
      const htmlParts: string[] = [];
      let allAtt: MimeAttachmentPart[] = [];
      for (const sub of subs) {
        const r = parseMimePart(sub);
        if (r.bodyText) plainParts.push(r.bodyText);
        if (r.bodyHtml) htmlParts.push(r.bodyHtml);
        allAtt = allAtt.concat(r.attachments);
      }
      const best = pickBestAlternative(plainParts, htmlParts);
      return {
        bodyText: best.bodyText,
        bodyHtml: best.bodyHtml,
        attachments: allAtt,
      };
    }

    // multipart/signed etc.: merge all subparts
    let plainParts: string[] = [];
    let htmlParts: string[] = [];
    let atts: MimeAttachmentPart[] = [];
    for (const sub of subs) {
      const r = parseMimePart(sub);
      if (r.bodyText) plainParts.push(r.bodyText);
      if (r.bodyHtml) htmlParts.push(r.bodyHtml);
      atts = atts.concat(r.attachments);
    }
    const best = pickBestAlternative(plainParts, htmlParts);
    return { bodyText: best.bodyText, bodyHtml: best.bodyHtml, attachments: atts };
  }

  // Leaf
  const { type: dispType, filename: dispFn } = getDisposition(headers);
  const fn = dispFn;
  const forceAtt = options?.forceAttachment === true;

  if (!forceAtt && isBodyTextLeaf(headers)) {
    const { subtype } = getMainMediaType(headers);
    const text = decodeBodyToText(headers, body).trim();
    if (subtype === "html") {
      return { bodyText: "", bodyHtml: text || null, attachments: [] };
    }
    return { bodyText: text, bodyHtml: null, attachments: [] };
  }

  // text/plain|html：仅 Content-Disposition: attachment 才当附件（Shopify 联系表单 html 常带 name=）
  if (main === "text") {
    const { subtype } = getMainMediaType(headers);
    const text = decodeBodyToText(headers, body).trim();
    if (subtype === "plain" || subtype === "html") {
      if (shouldTreatTextPartAsAttachment(headers)) {
        const bytes = decodeBodyToBytes(headers, body);
        return {
          bodyText: "",
          bodyHtml: null,
          attachments: [{
            filename: safeFilename(fn, full, 0),
            contentType: full,
            bytes,
          }],
        };
      }
      if (subtype === "html") {
        return { bodyText: "", bodyHtml: text || null, attachments: [] };
      }
      return { bodyText: text, bodyHtml: null, attachments: [] };
    }
  }

  const bytes = decodeBodyToBytes(headers, body);
  return {
    bodyText: "",
    bodyHtml: null,
    attachments: [{
      filename: safeFilename(fn, full, 0),
      contentType: full || "application/octet-stream",
      bytes,
    }],
  };
}

function collectTextLikeMimeParts(raw: string): { plainParts: string[]; htmlParts: string[] } {
  const plainParts: string[] = [];
  const htmlParts: string[] = [];
  const re = /content-type:\s*text\/(?:plain|html)\b[\s\S]*?(?=\r?\n--[^\r\n]+(?:--)?\r?\n|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const block = m[0].trim();
    const { headers, body } = splitHeadersBody(block);
    if (!headers.trim() || !body.trim()) continue;
    const { subtype } = getMainMediaType(headers);
    const text = decodeBodyToText(headers, body).trim();
    if (!text) continue;
    if (subtype === "html") htmlParts.push(text);
    else if (subtype === "plain") plainParts.push(text);
  }
  return { plainParts, htmlParts };
}

function fallbackBodyFromRaw(raw: string): { bodyText: string; bodyHtml: string | null } {
  const collected = collectTextLikeMimeParts(raw);
  const best = pickBestAlternative(collected.plainParts, collected.htmlParts);
  if (best.bodyText || best.bodyHtml) return best;

  let payload = mimePayloadOnly(raw).trim();
  if (!payload) return { bodyText: "", bodyHtml: null };
  if (looksLikeQuotedPrintable(payload)) {
    payload = decodeQuotedPrintableLoose(payload);
  }
  const looksHtml = /<\/?[a-z][\s\S]*>/i.test(payload);
  if (looksHtml) {
    return { bodyText: htmlToText(payload), bodyHtml: payload };
  }
  return { bodyText: payload.trim(), bodyHtml: null };
}

function promoteMisclassifiedTextAttachments(
  bodyText: string,
  bodyHtml: string | null,
  attachments: MimeAttachmentPart[],
): { bodyText: string; bodyHtml: string | null; attachments: MimeAttachmentPart[] } {
  let text = bodyText;
  let html = bodyHtml;
  const kept: MimeAttachmentPart[] = [];

  for (const a of attachments) {
    const ct = (a.contentType || "").split(";")[0].trim().toLowerCase();
    if (!html && ct === "text/html" && a.bytes.length > 0 && a.bytes.length <= MAX_ATTACHMENT_BYTES) {
      let decoded = new TextDecoder().decode(a.bytes);
      if (looksLikeQuotedPrintable(decoded)) decoded = decodeQuotedPrintableLoose(decoded);
      html = decoded;
      if (!text.trim()) text = htmlToText(decoded);
      continue;
    }
    if (!text.trim() && !html && ct === "text/plain" && a.bytes.length > 0 && a.bytes.length <= MAX_ATTACHMENT_BYTES) {
      let decoded = new TextDecoder().decode(a.bytes);
      if (looksLikeQuotedPrintable(decoded)) decoded = decodeQuotedPrintableLoose(decoded);
      text = decoded;
      continue;
    }
    kept.push(a);
  }

  return { bodyText: text, bodyHtml: html, attachments: kept };
}

function repairQuotedPrintableBody(bodyText: string, bodyHtml: string | null): {
  bodyText: string;
  bodyHtml: string | null;
} {
  let text = bodyText.trim();
  let html = bodyHtml?.trim() ? bodyHtml.trim() : null;

  if (!html && text && looksLikeQuotedPrintable(text)) {
    const decoded = decodeQuotedPrintableLoose(text);
    if (/<\/?[a-z][\s\S]*>/i.test(decoded)) {
      html = decoded;
      text = htmlToText(decoded);
    } else {
      text = decoded;
    }
  } else if (html && looksLikeQuotedPrintable(html)) {
    html = decodeQuotedPrintableLoose(html);
    if (!text.trim()) text = htmlToText(html);
  }

  return { bodyText: text, bodyHtml: html };
}

function finalizeParseResult(r: ParseMimeResult, raw: string): ParseMimeResult {
  let bodyText = r.bodyText.trim();
  let bodyHtml = r.bodyHtml?.trim() ? r.bodyHtml.trim() : null;
  let attachments = [...r.attachments];

  if (!bodyText && !bodyHtml) {
    const fb = fallbackBodyFromRaw(raw);
    bodyText = fb.bodyText;
    bodyHtml = fb.bodyHtml;
  }

  const promoted = promoteMisclassifiedTextAttachments(bodyText, bodyHtml, attachments);
  bodyText = promoted.bodyText;
  bodyHtml = promoted.bodyHtml;
  attachments = promoted.attachments;

  const repaired = repairQuotedPrintableBody(bodyText, bodyHtml);
  bodyText = repaired.bodyText;
  bodyHtml = repaired.bodyHtml;

  if (!bodyHtml && bodyText && /<(html|head|body|div|p|table|tr|td|th|span|a|br|img|ul|ol|li|h[1-6]|blockquote|strong|em)\b[\s>]/i.test(bodyText)) {
    bodyHtml = bodyText;
    bodyText = htmlToText(bodyText);
  }

  return { bodyText, bodyHtml, attachments };
}

/** Top-level entry: RFC822 raw or MIME fragment → bodies + attachments (capped). */
export function parseFullMime(raw: string): ParseMimeResult {
  // 直接将原始内容传给 parseMimePart（包含 RFC822 头部），由其负责解析：
  // - 单 part 邮件：RFC822 头部中的 Content-Type / Content-Transfer-Encoding 仍可被正确读取
  // - 多 part 邮件：Content-Type: multipart/... 和 boundary 均可正确提取
  // - 匿名 multipart（以 --boundary 开头）：parseMimePart 内已有专门处理分支
  // 不再调用 mimePayloadOnly，避免其将 Content-Type 头剥离后导致正文变成无头纯文本、parseMimePart 返回空
  const r = parseMimePart(raw.trimStart());
  const attachments: MimeAttachmentPart[] = [];
  for (let i = 0; i < r.attachments.length && attachments.length < MAX_ATTACHMENTS; i++) {
    const a = r.attachments[i];
    if (a.bytes.length > MAX_ATTACHMENT_BYTES) continue;
    const slot = attachments.length;
    let base = a.filename?.trim() ?? "";
    if (!base || /^attachment-\d+$/i.test(base)) {
      base = "";
    }
    attachments.push({
      ...a,
      filename: safeFilename(base || null, a.contentType, slot),
    });
  }
  const finalized = finalizeParseResult(
    { bodyText: r.bodyText, bodyHtml: r.bodyHtml, attachments },
    raw,
  );
  return {
    bodyText: finalized.bodyText,
    bodyHtml: finalized.bodyHtml,
    attachments: finalized.attachments,
  };
}

export function extractTextFromMime(raw: string): string {
  return parseFullMime(raw).bodyText;
}

export function extractHtmlFromMime(raw: string): string | null {
  return parseFullMime(raw).bodyHtml;
}
