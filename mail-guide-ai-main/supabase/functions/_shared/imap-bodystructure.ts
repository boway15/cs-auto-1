/**
 * Parse IMAP BODYSTRUCTURE to list attachment part sections for per-part FETCH.
 */

export type AttachmentPartKind = "user" | "inline";

export type AttachmentPartSection = {
  section: string;
  filename: string | null;
  contentType: string;
  sizeBytes: number;
  contentId: string | null;
  kind: AttachmentPartKind;
  /** BODYSTRUCTURE Content-Transfer-Encoding（如 BASE64），用于单 part 直接解码 */
  encoding: string | null;
};

export function extractBodyStructure(raw: string): string | null {
  const idx = raw.toUpperCase().indexOf("BODYSTRUCTURE");
  if (idx < 0) return null;
  const start = raw.indexOf("(", idx);
  if (start < 0) return null;
  let depth = 0;
  let inQuote = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inQuote = false;
      continue;
    }
    if (ch === "\"") inQuote = true;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function tokenizeBodyStructure(input: string): string[] {
  const tokens: string[] = [];
  for (let i = 0; i < input.length;) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push(ch);
      i++;
      continue;
    }
    if (ch === "\"") {
      i++;
      let value = "";
      while (i < input.length) {
        const c = input[i++];
        if (c === "\\") value += input[i++] ?? "";
        else if (c === "\"") break;
        else value += c;
      }
      tokens.push(value);
      continue;
    }
    let value = "";
    while (i < input.length && !/\s|\(|\)/.test(input[i])) {
      value += input[i++];
    }
    tokens.push(value);
  }
  return tokens;
}

function isNilToken(t: string | undefined): boolean {
  return !t || t.toUpperCase() === "NIL";
}

function readParamList(tokens: string[], startIndex: { i: number }): Record<string, string> {
  const out: Record<string, string> = {};
  if (isNilToken(tokens[startIndex.i])) {
    startIndex.i++;
    return out;
  }
  if (tokens[startIndex.i] !== "(") return out;
  startIndex.i++;
  while (startIndex.i < tokens.length && tokens[startIndex.i] !== ")") {
    const key = tokens[startIndex.i++];
    if (isNilToken(key)) continue;
    const val = tokens[startIndex.i++];
    if (!isNilToken(val)) out[key.toLowerCase()] = val;
  }
  if (tokens[startIndex.i] === ")") startIndex.i++;
  return out;
}

function readDisposition(tokens: string[], startIndex: { i: number }): { type: string | null; filename: string | null } {
  if (isNilToken(tokens[startIndex.i])) {
    startIndex.i++;
    return { type: null, filename: null };
  }
  if (tokens[startIndex.i] !== "(") {
    startIndex.i++;
    return { type: null, filename: null };
  }
  startIndex.i++;
  const type = isNilToken(tokens[startIndex.i]) ? null : String(tokens[startIndex.i++]).toLowerCase();
  let filename: string | null = null;
  if (tokens[startIndex.i] === "(") {
    const params = readParamList(tokens, startIndex);
    filename = params.filename ?? params.name ?? null;
  } else if (!isNilToken(tokens[startIndex.i])) {
    startIndex.i++;
  }
  if (tokens[startIndex.i] === ")") startIndex.i++;
  return { type, filename };
}

function classifyAttachmentKind(
  type: string,
  dispType: string | null,
  filename: string | null,
): AttachmentPartKind | null {
  if (type === "multipart" || type === "message") return null;

  const isImage = type === "image";

  if (type === "text") {
    return dispType === "attachment" ? "user" : null;
  }

  if (dispType === "attachment") return "user";
  if (dispType === "inline" && isImage) return "inline";
  if (dispType === "inline") return "user"; // inline non-image e.g. PDF

  if (!dispType) {
    if (filename) return "user";
    if (isImage) return "inline";
    return "user";
  }

  return null;
}

function parseLeafPart(
  path: string[],
  tokens: string[],
  startIndex: { i: number },
): AttachmentPartSection | null {
  const type = String(tokens[startIndex.i++] ?? "").toLowerCase();
  const subtype = String(tokens[startIndex.i++] ?? "").toLowerCase();
  if (!type || type === ")" ) return null;

  const params = readParamList(tokens, startIndex);
  let contentId: string | null = null;
  if (!isNilToken(tokens[startIndex.i])) {
    const idToken = String(tokens[startIndex.i++]);
    contentId = idToken.replace(/^<(.+)>$/, "$1").trim() || null;
  } else {
    startIndex.i++;
  }
  startIndex.i++; // description (NIL or value)
  let encoding: string | null = null;
  if (!isNilToken(tokens[startIndex.i])) {
    encoding = String(tokens[startIndex.i++]).toLowerCase();
  } else {
    startIndex.i++;
  }
  const sizeRaw = tokens[startIndex.i++];
  const sizeBytes = parseInt(String(sizeRaw ?? "0"), 10) || 0;

  // text has extra line count; skip optional extension fields until closing paren of this leaf
  if (type === "text") {
    if (!isNilToken(tokens[startIndex.i]) && /^\d+$/.test(tokens[startIndex.i])) startIndex.i++;
  }

  let dispType: string | null = null;
  let dispFilename: string | null = null;
  // optional: md5, disposition, language, location
  if (tokens[startIndex.i] !== ")" && tokens[startIndex.i] !== "(") {
    startIndex.i++; // md5 (NIL or value)
  }
  if (tokens[startIndex.i] === "(") {
    const disp = readDisposition(tokens, startIndex);
    dispType = disp.type;
    dispFilename = disp.filename;
  }

  const filename = dispFilename ?? params.name ?? params.filename ?? null;
  const kind = classifyAttachmentKind(type, dispType, filename);
  if (kind === null) return null;

  const section = path.length > 0 ? path.join(".") : "1";
  const contentType = `${type}/${subtype || "octet-stream"}`;
  return {
    section,
    filename,
    contentType,
    sizeBytes: sizeBytes || 0,
    contentId,
    kind,
    encoding,
  };
}

function skipRemainderOfCurrentList(tokens: string[], startIndex: { i: number }) {
  let nested = 0;
  while (startIndex.i < tokens.length) {
    const token = tokens[startIndex.i++];
    if (token === "(") nested++;
    else if (token === ")") {
      if (nested === 0) break;
      nested--;
    }
  }
}

function parsePart(
  path: string[],
  tokens: string[],
  startIndex: { i: number },
): AttachmentPartSection[] {
  if (tokens[startIndex.i] !== "(") return [];
  startIndex.i++;

  const sections: AttachmentPartSection[] = [];
  if (tokens[startIndex.i] === "(") {
    let child = 1;
    while (tokens[startIndex.i] === "(") {
      sections.push(...parsePart([...path, String(child)], tokens, startIndex));
      child++;
    }
    skipRemainderOfCurrentList(tokens, startIndex);
    return sections;
  }

  const leaf = parseLeafPart(path, tokens, startIndex);
  skipRemainderOfCurrentList(tokens, startIndex);
  if (leaf) sections.push(leaf);
  return sections;
}

/** List attachment MIME parts with IMAP section numbers (e.g. "2", "1.2"). */
export function parseAttachmentPartSections(metaRaw: string): AttachmentPartSection[] {
  const bodyStructure = extractBodyStructure(metaRaw);
  if (!bodyStructure) return [];
  const tokens = tokenizeBodyStructure(bodyStructure);
  const idx = { i: 0 };
  return parsePart([], tokens, idx);
}

export function countUserAttachments(metaRaw: string): number {
  return parseAttachmentPartSections(metaRaw).filter((p) => p.kind === "user").length;
}

export function countInlineAttachments(metaRaw: string): number {
  return parseAttachmentPartSections(metaRaw).filter((p) => p.kind === "inline").length;
}

/**
 * 从 FETCH 元数据（含 BODYSTRUCTURE）判断是否需要按「有媒体」拉取整封/附件。
 * - hasAttachment：user 附件或 inline 图（含 iPhone multipart/related）均为 true，避免只拉 BODY[TEXT] 导致 cid 破图
 * - count：仍只计 user 附件数（对齐 Gmail「用户附件」口径）
 */
export function detectAttachmentsFromMeta(metaRaw: string): {
  hasAttachment: boolean;
  count: number;
  inlineCount: number;
} {
  const raw = metaRaw;
  let hasAttachment = false;

  if (/"attachment"/i.test(raw)) hasAttachment = true;
  if (/BODYSTRUCTURE/i.test(raw) && /\bMIXED\b/i.test(raw)) hasAttachment = true;
  // IMAP BODYSTRUCTURE 常见 ("NAME" "file.jpeg")，不是 NAME="..."
  if (
    /FILENAME\s*=/i.test(raw) ||
    /\bNAME\s*=\s*"/i.test(raw) ||
    /\(\s*"NAME"\s+"/i.test(raw)
  ) {
    hasAttachment = true;
  }
  // iPhone / Apple Mail：RELATED + IMAGE，常无 MIXED、无 disposition=attachment
  if (/BODYSTRUCTURE/i.test(raw) && /\bRELATED\b/i.test(raw) && /\bIMAGE\b/i.test(raw)) {
    hasAttachment = true;
  }

  const structureOk = extractBodyStructure(raw) != null;
  const parts = structureOk ? parseAttachmentPartSections(raw) : [];
  const userCount = parts.filter((p) => p.kind === "user").length;
  const inlineCount = parts.filter((p) => p.kind === "inline").length;
  if (userCount > 0 || inlineCount > 0) hasAttachment = true;

  const count = structureOk ? userCount : (hasAttachment ? 1 : 0);
  return { hasAttachment, count, inlineCount };
}
