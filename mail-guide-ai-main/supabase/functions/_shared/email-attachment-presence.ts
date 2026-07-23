/**
 * 附件/内联图是否已落库、正文是否含 cid、要素缺失判定共用逻辑。
 */

export function bodyHasCidImageReferences(s: string | null | undefined): boolean {
  const raw = s?.trim() ?? "";
  if (!raw) return false;
  return (
    /\[cid:[^\]]+\]/i.test(raw) ||
    /<img\b[^>]*\bsrc\s*=\s*["']?cid:/i.test(raw) ||
    /(?<![\w/"'=])cid:[^\s<>\[\]"']+/i.test(raw) ||
    /<[a-z0-9_().-]+\.(?:png|jpe?g|gif|webp|bmp|svg)>/i.test(raw)
  );
}

function isInvalidStoredAttachmentMeta(item: Record<string, unknown>): boolean {
  const ct = String(item.contentType ?? item.content_type ?? "").split(";")[0].trim().toLowerCase();
  if (ct.startsWith("multipart/") || ct.startsWith("message/")) return true;
  const size = item.size ?? item.size_bytes;
  if (typeof size === "number" && size <= 0) return true;
  const fn = String(item.filename ?? "").trim().toLowerCase();
  if (/^attachment-\d+\./i.test(fn) && ct === "application/octet-stream") return true;
  if (/^attachment-\d+$/.test(fn) && !/\.[a-z0-9]{2,8}$/i.test(fn)) {
    if (ct.startsWith("multipart/") || ct.startsWith("message/") || ct === "application/octet-stream") {
      return true;
    }
  }
  return false;
}

/** emails.attachments 是否尚无有效 storage_path / url 可预览或下载 */
export function attachmentsJsonNeedsBinarySync(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return true;
  const hasValid = value.some((item) => {
    if (!item || typeof item !== "object") return false;
    const o = item as Record<string, unknown>;
    if (isInvalidStoredAttachmentMeta(o)) return false;
    if (typeof o.storage_path === "string" && o.storage_path.trim()) return true;
    if (typeof o.url === "string" && o.url.trim()) return true;
    return false;
  });
  return !hasValid;
}

export type EmailMediaPresenceRow = {
  has_attachment?: boolean | null;
  attachments?: unknown;
  body_html?: string | null;
  body_text?: string | null;
};

/**
 * 需要从 IMAP 补拉媒体二进制：占位/空附件，或正文有 cid 但本地无图。
 * 不依赖 has_attachment（历史误标 false 的 inline 信也要扫到）。
 */
export function emailNeedsMediaBinarySync(row: EmailMediaPresenceRow): boolean {
  if (attachmentsJsonNeedsBinarySync(row.attachments)) {
    const hasCid =
      bodyHasCidImageReferences(row.body_html) || bodyHasCidImageReferences(row.body_text);
    if (hasCid) return true;
    if (row.has_attachment === true) return true;
    // 无 cid、也未标有附件：空 attachments 不强制补拉
    if (!Array.isArray(row.attachments) || row.attachments.length === 0) {
      return false;
    }
    return true;
  }
  return false;
}

/** 业务侧是否视为「已有附件/凭证图」（含已落库内联图） */
export function emailHasAttachmentEvidence(email: {
  has_attachment?: boolean | null;
  attachments?: unknown;
}): boolean {
  if (email.has_attachment === true) return true;
  if (!Array.isArray(email.attachments)) return false;
  return email.attachments.some((item) => {
    if (!item || typeof item !== "object") return false;
    const o = item as Record<string, unknown>;
    if (isInvalidStoredAttachmentMeta(o)) return false;
    const pathOk = typeof o.storage_path === "string" && o.storage_path.trim().length > 0;
    const urlOk = typeof o.url === "string" && o.url.trim().length > 0;
    if (!pathOk && !urlOk) return false;
    const ct = String(o.contentType ?? o.content_type ?? "").split(";")[0].trim().toLowerCase();
    const fn = String(o.filename ?? "").toLowerCase();
    if (ct.startsWith("image/")) return true;
    if (/\.(jpe?g|png|gif|webp|bmp|pdf|zip|heic)$/i.test(fn)) return true;
    return pathOk || urlOk;
  });
}
