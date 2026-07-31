/**
 * Recursive MIME parsing for Edge (Deno): bodies (multipart/alternative, mixed)
 * and binary attachment leaves. RFC-ish boundary splitting; not a full mail parser.
 */

export interface MimeAttachmentPart {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  /** MIME Content-ID，用于正文 cid: 引用映射 */
  contentId?: string | null;
}

export interface ParseMimeResult {
  bodyText: string;
  bodyHtml: string | null;
  attachments: MimeAttachmentPart[];
}

const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const CHARSET_ALIASES: Record<string, string> = {
  gb2312: "gb18030",
  gb_2312: "gb18030",
  "gb_2312-80": "gb18030",
  gbk: "gbk",
  "x-gbk": "gbk",
  cp936: "gbk",
  ms936: "gbk",
  "windows-936": "gbk",
  "big5-hkscs": "big5",
  "x-mac-chinesetrad": "big5",
  "iso-8859-1": "windows-1252",
  latin1: "windows-1252",
  us_ascii: "utf-8",
  "us-ascii": "utf-8",
  ascii: "utf-8",
};

const MIME_PART_HEADER_LINE_RE =
  /^(content-type|content-transfer-encoding|content-disposition|content-id|content-description|mime-version)\s*:/i;

/** MIME 头折行续行或截断后的参数行（BODY[TEXT] 常丢失 Content-Type: 前缀） */
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

/** Normalize declared MIME charset to a label TextDecoder accepts. */
export function normalizeMimeCharset(charset: string | null | undefined): string {
  const raw = String(charset ?? "utf-8").trim().toLowerCase().replace(/['"]/g, "");
  if (!raw) return "utf-8";
  return CHARSET_ALIASES[raw] ?? raw;
}

function replacementCharCount(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (ch === "\uFFFD") n++;
  }
  return n;
}

/** Decode bytes using declared charset with GBK/UTF-8 fallbacks for Chinese mail. */
export function decodeBytesWithCharset(bytes: Uint8Array, declaredCharset?: string | null): string {
  const primary = normalizeMimeCharset(declaredCharset);
  const candidates = [primary, "utf-8", "gb18030", "gbk", "big5", "windows-1252"];
  const seen = new Set<string>();
  let best = "";
  let bestScore = Number.POSITIVE_INFINITY;
  for (const label of candidates) {
    if (seen.has(label)) continue;
    seen.add(label);
    try {
      const text = new TextDecoder(label, { fatal: false }).decode(bytes);
      const score = replacementCharCount(text);
      if (score < bestScore) {
        bestScore = score;
        best = text;
        if (score === 0) break;
      }
    } catch {
      // try next candidate
    }
  }
  return best || new TextDecoder().decode(bytes);
}

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

/** BODY[TEXT] 等片段偶发无空行分隔，整段 MIME 头（含截断/折行）被误当正文入库 */
export function isMimeHeadersOnlyBody(text: string | null | undefined): boolean {
  const s = String(text ?? "").trim();
  if (!s || s.length > 2000) return false;
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > 12) return false;
  if (!lines.every(isMimeMetadataLine)) return false;
  return hasStrongMimeMetadataSignal(lines);
}

function splitHeadersBodyLoose(part: string): { headers: string; body: string } | null {
  const p = part.replace(/^\r?\n/, "").trimStart();
  if (!/^content-type\s*:/i.test(p)) return null;

  const lines = p.split(/\r?\n/);
  const headerLines: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && /^content-type\s*:/i.test(line)) {
      headerLines.push(line);
      continue;
    }
    if (headerLines.length > 0 && /^[\w-]+\s*:/.test(line)) {
      headerLines.push(line);
      continue;
    }
    break;
  }
  if (headerLines.length === 0) return null;
  return {
    headers: headerLines.join("\r\n"),
    body: lines.slice(i).join("\r\n").replace(/\r?\n$/, "").trimEnd(),
  };
}

export function splitHeadersBody(part: string): { headers: string; body: string } {
  const p = part.replace(/^\r?\n/, "").trimStart();
  const m = /\r?\n\r?\n/.exec(p);
  if (m) {
    return {
      headers: p.slice(0, m.index),
      body: p.slice(m.index + m[0].length).replace(/\r?\n$/, "").trimEnd(),
    };
  }
  const loose = splitHeadersBodyLoose(p);
  if (loose) return loose;
  return { headers: "", body: p };
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
        return decodeBytesWithCharset(bytes, charset);
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
        return decodeBytesWithCharset(new Uint8Array(bytes), charset);
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
    const charset = normalizeMimeCharset(rvParts[1] || "utf-8");
    v = rvParts[3];
    try {
      const decoded = decodeURIComponent(v);
      return decoded || null;
    } catch {
      try {
        // 回退：逐字节 percent-decode 后用指定 charset 解码
        const bytes = v.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        return decodeBytesWithCharset(new TextEncoder().encode(bytes), charset) || null;
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
        charset = normalizeMimeCharset(head[1] || "utf-8");
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
          combined += decodeBytesWithCharset(u8, charset);
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
  "application/octet-stream": ".bin",
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

/** 头里缺 boundary 时从正文首行 --token 推断（Outlook/Hotmail 偶发） */
function inferBoundaryFromBody(body: string): string | null {
  const m = body.trimStart().match(/^--([^\s\r\n;]+)/);
  return m?.[1]?.trim() || null;
}

function resolveMultipartBoundary(contentTypeLine: string, body: string): string | null {
  return getBoundary(contentTypeLine) ?? inferBoundaryFromBody(body);
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

/** RFC 2045 Content-ID（去掉尖括号） */
export function extractContentId(headers: string): string | null {
  const m = unfoldHeaders(headers).match(/content-id:\s*<?([^>\s;]+)>?/i);
  return m?.[1]?.trim() || null;
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

/** BODY[TEXT] 等无 MIME 头片段：判断是否像 base64 正文 payload */
export function looksLikeBase64Payload(s: string): boolean {
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

/** 无 Content-Transfer-Encoding 头时尝试 base64 解码（send-reply / BODY[TEXT] 常见） */
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

export function hasReadableEmailBody(
  bodyText: string | null | undefined,
  bodyHtml: string | null | undefined,
): boolean {
  const text = String(bodyText ?? "").trim();
  const html = String(bodyHtml ?? "").trim();
  if (
    html &&
    !isUndecodedBase64Body(html) &&
    !isMimeHeadersOnlyBody(html) &&
    !isMobileSignatureOnlyText(htmlToText(html))
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

/**
 * Decode IMAP BODY.PEEK[section] payload using BODYSTRUCTURE encoding.
 * Prefer this over parseFullMime when the FETCH body has no MIME headers.
 */
export function decodeImapPartPayload(
  raw: string,
  encoding: string | null | undefined,
): Uint8Array | null {
  const trimmed = String(raw ?? "");
  if (!trimmed.trim()) return null;
  const enc = String(encoding ?? "").trim().toLowerCase().replace(/^"+|"+$/g, "");

  const fromBase64 = (payload: string): Uint8Array | null => {
    try {
      const b = joinBase64Payload(payload);
      if (!b) return null;
      const bin = atob(b);
      if (!bin.length) return null;
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  };

  try {
    if (enc === "base64" || enc === "b") {
      return fromBase64(trimmed);
    }
    if (enc === "quoted-printable" || enc === "qp") {
      const buf: number[] = [];
      for (let i = 0; i < trimmed.length; i++) {
        if (trimmed[i] === "=") {
          if (i + 2 < trimmed.length) {
            if (trimmed[i + 1] === "\r" && trimmed[i + 2] === "\n") {
              i += 2;
              continue;
            }
            if (trimmed[i + 1] === "\n") {
              i += 1;
              continue;
            }
            const hex = trimmed.substring(i + 1, i + 3);
            if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
              buf.push(parseInt(hex, 16));
              i += 2;
              continue;
            }
          }
        } else if (trimmed[i] !== "\r") {
          buf.push(trimmed.charCodeAt(i) & 0xff);
        }
      }
      return buf.length > 0 ? new Uint8Array(buf) : null;
    }

    if (!enc && looksLikeBase64Payload(trimmed)) {
      const decoded = fromBase64(trimmed);
      if (decoded) return decoded;
    }

    // 7bit / 8bit / binary / unknown: octet stream from string code units
    const out = new Uint8Array(trimmed.length);
    for (let i = 0; i < trimmed.length; i++) out[i] = trimmed.charCodeAt(i) & 0xff;
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function decodeBodyToBytes(headers: string, body: string): Uint8Array {
  const charset = normalizeMimeCharset(headers.match(/charset=(["']?)([^"';\s]+)\1/i)?.[2]);
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
  const charset = headers.match(/charset=(["']?)([^"';\s]+)\1/i)?.[2] ?? "utf-8";
  return decodeBytesWithCharset(bytes, charset);
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

/** 仅手机默认签名（无实质正文）。iPhone 常把签名拆成 multipart/mixed 末段 text/plain。 */
export function isMobileSignatureOnlyText(text: string | null | undefined): boolean {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 80) return false;
  return /^(sent from my (iphone|ipad|ipod)|sent from mail for windows|get outlook for (ios|android)|envoy[eé] de mon iphone|von meinem iphone gesendet|iphoneから送信)\.?$/i.test(
    t,
  );
}

/** 纯文本引用区起始（Gmail 英/中、Outlook From:；含 IMAP 压扁无换行） */
const PLAIN_QUOTE_START_RES: RegExp[] = [
  /\n\nOn\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),[\s\S]{8,220}?wrote:\s*/i,
  /\nOn\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),[\s\S]{8,220}?wrote:\s*/i,
  /On\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),[\s\S]{8,220}?wrote:\s*/i,
  /On\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},[\s\S]{8,220}?wrote:\s*/i,
  /\n\nFrom\s*[：:]/i,
  /\nFrom\s*[：:]/i,
  /\n\n\d{4}年[\s\S]{4,120}?写道[：:]/,
  /\n\d{4}年[\s\S]{4,120}?写道[：:]/,
  /\d{4}年[\s\S]{4,120}?写道[：:]/,
];

function findPlainQuoteStartIndex(text: string): number {
  let earliest = -1;
  for (const re of PLAIN_QUOTE_START_RES) {
    const m = re.exec(text);
    if (!m || m.index < 0) continue;
    if (earliest < 0 || m.index < earliest) earliest = m.index;
  }
  return earliest;
}

/** 引用标记前的客户最新正文（供 MIME 选段评分） */
export function extractTopBeforeQuote(text: string): string {
  const t = String(text ?? "").trim();
  if (!t) return "";
  const idx = findPlainQuoteStartIndex(t);
  if (idx <= 0) return t;
  return t.slice(0, idx).trim();
}

function hasPlainQuoteMarker(text: string): boolean {
  return findPlainQuoteStartIndex(text) >= 0;
}

function hasSubstantialTopBeforeQuote(text: string): boolean {
  return extractTopBeforeQuote(text).trim().length >= 8;
}

function isQuoteOnlyPlainBody(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t || !hasPlainQuoteMarker(t)) return false;
  return !hasSubstantialTopBeforeQuote(t);
}

function extractTopBeforeQuoteFromHtml(html: string): string {
  const h = String(html ?? "").trim();
  if (!h) return "";
  const quoteIdx = h.search(/class=["'][^"']*gmail_quote/i);
  const topHtml = quoteIdx > 0 ? h.slice(0, quoteIdx) : h;
  return htmlToText(topHtml).trim();
}

function plainTopNotRepresentedInHtml(plainTop: string, html: string): boolean {
  const p = plainTop.trim();
  if (p.length < 8) return false;
  const htmlVis = extractTopBeforeQuoteFromHtml(html).toLowerCase();
  const words = p
    .replace(/\s+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 8);
  if (words.length < 2) return false;
  const matched = words.filter((w) => htmlVis.includes(w.toLowerCase())).length;
  return matched < Math.ceil(words.length * 0.5);
}

function scoreBodyCandidate(text: string): number {
  const t = text.trim();
  if (!t) return -1;
  if (isMobileSignatureOnlyText(t)) return 1;
  const topLen = extractTopBeforeQuote(t).length;
  if (topLen >= 8 && hasPlainQuoteMarker(t)) {
    return 1_000_000 + topLen;
  }
  if (topLen >= 8) {
    return 500_000 + topLen;
  }
  if (isQuoteOnlyPlainBody(t)) {
    return 50 + t.length;
  }
  return 100 + t.length;
}

/** 多段 text 时优先实质正文；避免 .pop() 只拿到末尾「Sent from my iPhone」。 */
function pickBestBodyPart(parts: string[]): string {
  let best = "";
  let bestScore = -1;
  for (const part of parts) {
    const t = String(part ?? "").trim();
    if (!t) continue;
    const score = scoreBodyCandidate(t);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

function pickBestAlternative(plainParts: string[], htmlParts: string[]): { bodyText: string; bodyHtml: string | null } {
  const plain = pickBestBodyPart(plainParts);
  const html = pickBestBodyPart(htmlParts) || null;
  let bodyText = plain;
  if (html) {
    const stripped = htmlToText(html);
    if (!bodyText && stripped) bodyText = stripped;
    // HTML 仅签名、plain 有实质内容时保留 plain
    if (bodyText && isMobileSignatureOnlyText(stripped) && !isMobileSignatureOnlyText(bodyText)) {
      return { bodyText, bodyHtml: null };
    }
    // plain 含引用前新回复、html 未体现该片段（如 Shopify 模板）时回退 plain
    const plainTop = extractTopBeforeQuote(bodyText).trim();
    if (plainTop.length >= 8 && plainTopNotRepresentedInHtml(plainTop, html)) {
      return { bodyText, bodyHtml: null };
    }
  }
  return { bodyText, bodyHtml: html || null };
}

function isMessageRfc822Part(headers: string): boolean {
  const { main, full } = getMainMediaType(headers);
  return main === "message" && /rfc822|global|external-body/i.test(full);
}

function isMultipartAlternativePart(headers: string): boolean {
  const { main, subtype } = getMainMediaType(headers);
  return main === "multipart" && subtype === "alternative";
}

function pickBestFromMixedSubparts(
  altPlain: string[],
  altHtml: string[],
  fallbackPlain: string[],
  fallbackHtml: string[],
): { bodyText: string; bodyHtml: string | null } {
  const altBest = pickBestAlternative(altPlain, altHtml);
  if (altBest.bodyText || altBest.bodyHtml) {
    if (!isQuoteOnlyPlainBody(altBest.bodyText) || hasSubstantialTopBeforeQuote(altBest.bodyText)) {
      return altBest;
    }
  }
  const mergedPlain = [...altPlain, ...fallbackPlain];
  const mergedHtml = [...altHtml, ...fallbackHtml];
  return pickBestAlternative(mergedPlain, mergedHtml);
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

function dedupeAttachmentParts(parts: MimeAttachmentPart[]): MimeAttachmentPart[] {
  const seen = new Set<string>();
  const out: MimeAttachmentPart[] = [];
  for (const p of parts) {
    const key = `${p.filename}\0${p.bytes.length}\0${p.contentType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export type ParseMimePartOptions = {
  forceAttachment?: boolean;
  /** 仅提取附件，跳过正文解码（超大邮件附件补拉时降低 CPU） */
  attachmentsOnly?: boolean;
};

/** Parse one MIME part (headers + body or nested fragment). */
export function parseMimePart(part: string, options?: ParseMimePartOptions): ParseMimeResult {
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
    if (!text) return empty;
    const decoded = decodeBase64BodyLoose(text);
    return { bodyText: decoded ?? text, bodyHtml: null, attachments: [] };
  }

  const ctLine = unfoldHeaders(headers).match(/content-type:\s*([^\r\n]+)/i)?.[1] ?? "";
  const boundary = resolveMultipartBoundary(ctLine, body);
  const { main, full } = getMainMediaType(headers);

  if (main === "multipart" && boundary) {
    const subs = splitByBoundary(body, boundary);
    const subtype = full.split("/")[1] ?? "";

    if (subtype === "alternative") {
      const plainParts: string[] = [];
      const htmlParts: string[] = [];
      let atts: MimeAttachmentPart[] = [];
      for (const sub of subs) {
        const r = parseMimePart(sub, options);
        if (!options?.attachmentsOnly) {
          if (r.bodyText) plainParts.push(r.bodyText);
          if (r.bodyHtml) htmlParts.push(r.bodyHtml);
        }
        atts = atts.concat(r.attachments);
      }
      if (options?.attachmentsOnly) {
        return { bodyText: "", bodyHtml: null, attachments: atts };
      }
      const best = pickBestAlternative(plainParts, htmlParts);
      return { bodyText: best.bodyText, bodyHtml: best.bodyHtml, attachments: atts };
    }

    if (subtype === "mixed" || subtype === "related") {
      if (subs.length === 0) return empty;
      const altPlain: string[] = [];
      const altHtml: string[] = [];
      const fallbackPlain: string[] = [];
      const fallbackHtml: string[] = [];
      let allAtt: MimeAttachmentPart[] = [];
      for (const sub of subs) {
        const { headers: subH, body: subB } = splitHeadersBody(sub.trim());
        const r = parseMimePart(sub, options);
        if (!options?.attachmentsOnly && subH.trim() && !isMessageRfc822Part(subH)) {
          const poolPlain = isMultipartAlternativePart(subH) ? altPlain : fallbackPlain;
          const poolHtml = isMultipartAlternativePart(subH) ? altHtml : fallbackHtml;
          if (r.bodyText) poolPlain.push(r.bodyText);
          if (r.bodyHtml) poolHtml.push(r.bodyHtml);
        }
        allAtt = allAtt.concat(r.attachments);
        if (!subH.trim()) continue;
        const subMeta = getMainMediaType(subH);
        if (subMeta.main === "image" || subMeta.main === "application") {
          const fn = extractAttachmentFilename(subH);
          const bytes = decodeBodyToBytes(subH, subB);
          if (bytes.length > 0 && bytes.length <= MAX_ATTACHMENT_BYTES) {
            allAtt.push({
              filename: safeFilename(fn, subMeta.full, allAtt.length),
              contentType: subMeta.full,
              bytes,
              contentId: extractContentId(subH),
            });
          }
        }
      }
      if (options?.attachmentsOnly) {
        return { bodyText: "", bodyHtml: null, attachments: dedupeAttachmentParts(allAtt) };
      }
      const best = pickBestFromMixedSubparts(altPlain, altHtml, fallbackPlain, fallbackHtml);
      const dedupedAtt = dedupeAttachmentParts(allAtt);
      return {
        bodyText: best.bodyText,
        bodyHtml: best.bodyHtml,
        attachments: dedupedAtt,
      };
    }

    // multipart/signed etc.: merge all subparts
    let plainParts: string[] = [];
    let htmlParts: string[] = [];
    let atts: MimeAttachmentPart[] = [];
    for (const sub of subs) {
      const r = parseMimePart(sub, options);
      if (!options?.attachmentsOnly) {
        if (r.bodyText) plainParts.push(r.bodyText);
        if (r.bodyHtml) htmlParts.push(r.bodyHtml);
      }
      atts = atts.concat(r.attachments);
    }
    if (options?.attachmentsOnly) {
      return { bodyText: "", bodyHtml: null, attachments: atts };
    }
    const best = pickBestAlternative(plainParts, htmlParts);
    return { bodyText: best.bodyText, bodyHtml: best.bodyHtml, attachments: atts };
  }

  // Leaf
  const { type: dispType, filename: dispFn } = getDisposition(headers);
  const fn = dispFn;
  const forceAtt = options?.forceAttachment === true;

  if (options?.attachmentsOnly && !forceAtt && !hasAttachmentDisposition(headers)) {
    const { main: leafMain } = getMainMediaType(headers);
    if (leafMain === "text" || leafMain === "multipart" || leafMain === "message") {
      if (leafMain !== "text" || !shouldTreatTextPartAsAttachment(headers)) {
        return empty;
      }
    }
  }

  if (!forceAtt && isBodyTextLeaf(headers)) {
    if (options?.attachmentsOnly) return empty;
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
          attachments: bytes.length > 0 ? [{
            filename: safeFilename(fn, full, 0),
            contentType: full,
            bytes,
            contentId: extractContentId(headers),
          }] : [],
        };
      }
      if (subtype === "html") {
        return { bodyText: "", bodyHtml: text || null, attachments: [] };
      }
      return { bodyText: text, bodyHtml: null, attachments: [] };
    }
  }

  // multipart/message 不应作为二进制附件落库（Outlook 常见误解析为 attachment-1）
  if (main === "multipart" || main === "message") {
    if (main === "message" && /rfc822|global|external-body/i.test(full)) {
      return parseMimePart(body.trimStart(), options);
    }
    const nested = parseMimePart(`${headers}\r\n\r\n${body}`, options);
    if (nested.bodyText.trim() || nested.bodyHtml || nested.attachments.length > 0) {
      return nested;
    }
    const trimmedBody = body.trimStart();
    const firstLine = trimmedBody.split(/\r?\n/, 1)[0] ?? "";
    if (/^--[^\s\r\n]+/.test(firstLine)) {
      return parseMimePart(trimmedBody, options);
    }
    return empty;
  }

  const bytes = decodeBodyToBytes(headers, body);
  if (bytes.length === 0) return empty;
  return {
    bodyText: "",
    bodyHtml: null,
    attachments: [{
      filename: safeFilename(fn, full, 0),
      contentType: full || "application/octet-stream",
      bytes,
      contentId: extractContentId(headers),
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
  const b64Decoded = decodeBase64BodyLoose(payload);
  if (b64Decoded) return { bodyText: b64Decoded.trim(), bodyHtml: null };
  if (looksLikeQuotedPrintable(payload)) {
    payload = decodeQuotedPrintableLoose(payload);
  }
  const looksHtml = /<\/?[a-z][\s\S]*>/i.test(payload);
  if (looksHtml) {
    return { bodyText: htmlToText(payload), bodyHtml: payload };
  }
  const bodyText = payload.trim();
  if (isMimeHeadersOnlyBody(bodyText)) return { bodyText: "", bodyHtml: null };
  return { bodyText, bodyHtml: null };
}

/** 根据魔数/内容修正类型与文件名，避免无扩展名或 HTML 误当二进制附件 */
function refineAttachmentPartMeta(part: MimeAttachmentPart, index: number): MimeAttachmentPart | null {
  const bytes = part.bytes;
  if (!bytes.length) return null;

  const ctMain = (part.contentType || "").split(";")[0].trim().toLowerCase();
  let filename = part.filename?.trim() || "";

  const headText = (() => {
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, Math.min(2048, bytes.length)));
    } catch {
      return "";
    }
  })().trimStart();

  if (
    ctMain.startsWith("multipart/") ||
    ctMain.startsWith("message/") ||
    ctMain === "text/html" ||
    ctMain === "text/plain" ||
    (ctMain.startsWith("text/") && /<(?:html|head|body|div|table|p)\b/i.test(headText)) ||
    (headText.startsWith("<") && /<(?:html|head|body|div|table|p)\b/i.test(headText))
  ) {
    return null;
  }

  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return {
      ...part,
      contentType: "application/pdf",
      filename: safeFilename(filename || null, "application/pdf", index),
    };
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return {
      ...part,
      contentType: "image/png",
      filename: safeFilename(filename || null, "image/png", index),
    };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return {
      ...part,
      contentType: "image/jpeg",
      filename: safeFilename(filename || null, "image/jpeg", index),
    };
  }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return {
      ...part,
      contentType: "application/zip",
      filename: safeFilename(filename || null, "application/zip", index),
    };
  }

  const refinedName = safeFilename(filename || null, part.contentType, index);
  return {
    ...part,
    filename: refinedName,
    contentType: part.contentType || "application/octet-stream",
  };
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
    if (ct === "text/html" && a.bytes.length > 0 && a.bytes.length <= MAX_ATTACHMENT_BYTES) {
      let decoded = new TextDecoder().decode(a.bytes);
      if (looksLikeQuotedPrintable(decoded)) decoded = decodeQuotedPrintableLoose(decoded);
      if (!html || decoded.length > html.length) html = decoded;
      if (!text.trim()) text = htmlToText(decoded);
      continue;
    }
    if (ct === "text/plain" && a.bytes.length > 0 && a.bytes.length <= MAX_ATTACHMENT_BYTES) {
      let decoded = new TextDecoder().decode(a.bytes);
      if (looksLikeQuotedPrintable(decoded)) decoded = decodeQuotedPrintableLoose(decoded);
      if (!text.trim() || decoded.length > text.length) text = decoded;
      continue;
    }
    const refined = refineAttachmentPartMeta(a, kept.length);
    if (refined) kept.push(refined);
  }

  return { bodyText: text, bodyHtml: html, attachments: kept };
}

function repairBase64EncodedBody(bodyText: string, bodyHtml: string | null): {
  bodyText: string;
  bodyHtml: string | null;
} {
  let text = bodyText.trim();
  let html = bodyHtml?.trim() ? bodyHtml.trim() : null;

  if (text && isUndecodedBase64Body(text)) {
    text = decodeBase64BodyLoose(text) ?? text;
  }
  if (html && isUndecodedBase64Body(html)) {
    html = decodeBase64BodyLoose(html);
    if (!text.trim() && html) text = htmlToText(html);
  }

  return { bodyText: text, bodyHtml: html };
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

  const b64Repaired = repairBase64EncodedBody(bodyText, bodyHtml);
  bodyText = b64Repaired.bodyText;
  bodyHtml = b64Repaired.bodyHtml;

  const repaired = repairQuotedPrintableBody(bodyText, bodyHtml);
  bodyText = repaired.bodyText;
  bodyHtml = repaired.bodyHtml;

  if (!bodyHtml && bodyText && /<(html|head|body|div|p|table|tr|td|th|span|a|br|img|ul|ol|li|h[1-6]|blockquote|strong|em)\b[\s>]/i.test(bodyText)) {
    bodyHtml = bodyText;
    bodyText = htmlToText(bodyText);
  }

  if (isMimeHeadersOnlyBody(bodyText)) bodyText = "";
  if (isMimeHeadersOnlyBody(bodyHtml)) bodyHtml = null;

  return { bodyText, bodyHtml, attachments };
}

function capAttachmentParts(parts: MimeAttachmentPart[]): MimeAttachmentPart[] {
  const attachments: MimeAttachmentPart[] = [];
  for (let i = 0; i < parts.length && attachments.length < MAX_ATTACHMENTS; i++) {
    const a = parts[i];
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
  return attachments;
}

/** Top-level entry: RFC822 raw or MIME fragment → bodies + attachments (capped). */
export function parseFullMime(
  raw: string,
  options?: { attachmentsOnly?: boolean; forceAttachment?: boolean },
): ParseMimeResult {
  const r = parseMimePart(raw.trimStart(), {
    attachmentsOnly: options?.attachmentsOnly,
    forceAttachment: options?.forceAttachment,
  });
  const attachments = capAttachmentParts(r.attachments);
  if (options?.attachmentsOnly) {
    return { bodyText: "", bodyHtml: null, attachments };
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
