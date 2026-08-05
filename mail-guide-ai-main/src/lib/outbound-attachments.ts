import { supabase } from "@/lib/supabase";

export const OUTBOUND_BUCKET = "outbound-attachments";
export const OUTBOUND_MAX_FILE_BYTES = 35 * 1024 * 1024;
export const OUTBOUND_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const OUTBOUND_MAX_FILES = 5;

const ALLOWED_EXT = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "zip",
]);
const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/png",
  "image/jpeg",
  "image/gif",
  "application/zip",
]);

/** 邮件附件展示名（保留中文等 Unicode） */
export function sanitizeOutboundFilename(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "attachment";
  return base.replace(/[\x00-\x1f]/g, "").trim() || "attachment";
}

/** Storage 对象 key 片段：仅 ASCII，避免 Supabase Storage Invalid key */
export function sanitizeOutboundStorageKeySegment(name: string): string {
  const cleaned = name.replace(/[/\\]/g, "_").replace(/\0/g, "").replace(/\s+/g, " ").trim();
  const extMatch = cleaned.match(/\.([A-Za-z0-9]{1,10})$/);
  const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : "";
  const stem = ext ? cleaned.slice(0, -ext.length) : cleaned;
  const asciiStem = stem
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_ .-]+|[_ .-]+$/g, "")
    .slice(0, 80);
  return `${asciiStem || "file"}${ext}`.slice(0, 120);
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function validateOutboundFile(
  file: Pick<File, "name" | "type" | "size">,
  currentTotalBytes: number,
): { ok: true } | { ok: false; reason: string } {
  if (file.size > OUTBOUND_MAX_FILE_BYTES) {
    return { ok: false, reason: `单文件不能超过 ${OUTBOUND_MAX_FILE_BYTES / 1024 / 1024}MB` };
  }
  if (currentTotalBytes + file.size > OUTBOUND_MAX_TOTAL_BYTES) {
    return { ok: false, reason: `附件总大小不能超过 ${OUTBOUND_MAX_TOTAL_BYTES / 1024 / 1024}MB` };
  }
  const ext = extOf(file.name);
  if (!ALLOWED_EXT.has(ext)) {
    return { ok: false, reason: `不支持的文件类型: .${ext || "?"}` };
  }
  if (file.type && !ALLOWED_MIME.has(file.type)) {
    return { ok: false, reason: `不支持的 MIME 类型: ${file.type}` };
  }
  return { ok: true };
}

export type OutboundAttachmentDraft = {
  id: string;
  file: File;
  storagePath?: string;
  uploading: boolean;
  error?: string;
};

export function buildOutboundStoragePath(
  userId: string,
  sessionId: string,
  file: File,
): string {
  const safe = sanitizeOutboundStorageKeySegment(file.name);
  return `${userId}/${sessionId}/${crypto.randomUUID()}_${safe}`;
}

export async function uploadOutboundAttachment(
  userId: string,
  sessionId: string,
  file: File,
): Promise<{ storagePath: string }> {
  const path = buildOutboundStoragePath(userId, sessionId, file);
  const { error } = await supabase.storage
    .from(OUTBOUND_BUCKET)
    .upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (error) throw error;
  return { storagePath: path };
}

export function formatOutboundFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type SendLogOutboundAttachment = {
  filename: string;
  content_type: string;
  storage_path: string;
};

/** 从 email_send_logs.metadata 解析发出附件清单 */
export function parseSendLogOutboundAttachments(
  metadata: Record<string, unknown> | null | undefined,
): SendLogOutboundAttachment[] {
  if (!metadata || !Array.isArray(metadata.attachments)) return [];
  const out: SendLogOutboundAttachment[] = [];
  for (const item of metadata.attachments) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const filename = typeof o.filename === "string" ? o.filename.trim() : "";
    const storage_path = typeof o.storage_path === "string" ? o.storage_path.trim() : "";
    if (!filename || !storage_path) continue;
    const content_type =
      typeof o.content_type === "string" && o.content_type.trim()
        ? o.content_type.trim()
        : "application/octet-stream";
    out.push({ filename, content_type, storage_path });
  }
  return out;
}

export function isOutboundImageAttachment(att: Pick<SendLogOutboundAttachment, "filename" | "content_type">): boolean {
  if (att.content_type.startsWith("image/")) return true;
  const ext = extOf(att.filename);
  return ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif";
}

export type SignedOutboundAttachmentUrls = {
  previewUrl: string | null;
  downloadUrl: string | null;
  error: string | null;
};

/** 为发送日志详情生成预览/下载签名 URL（文件已清理时 error 非空） */
export async function signSendLogOutboundAttachmentUrls(
  att: SendLogOutboundAttachment,
  expiresIn = 3600,
): Promise<SignedOutboundAttachmentUrls> {
  const previewResp = await supabase.storage
    .from(OUTBOUND_BUCKET)
    .createSignedUrl(att.storage_path, expiresIn);
  if (previewResp.error || !previewResp.data?.signedUrl) {
    return {
      previewUrl: null,
      downloadUrl: null,
      error: previewResp.error?.message || "附件不可访问（可能已清理）",
    };
  }
  const downloadResp = await supabase.storage
    .from(OUTBOUND_BUCKET)
    .createSignedUrl(att.storage_path, expiresIn, {
      download: sanitizeOutboundFilename(att.filename),
    });
  return {
    previewUrl: previewResp.data.signedUrl,
    downloadUrl: downloadResp.data?.signedUrl ?? previewResp.data.signedUrl,
    error: null,
  };
}
