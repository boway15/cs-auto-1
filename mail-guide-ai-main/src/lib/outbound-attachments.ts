import { supabase } from "@/lib/supabase";

export const OUTBOUND_BUCKET = "outbound-attachments";
export const OUTBOUND_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const OUTBOUND_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
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

export function sanitizeOutboundFilename(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "attachment";
  return base.replace(/[\x00-\x1f]/g, "").trim() || "attachment";
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
    return { ok: false, reason: "附件总大小不能超过 25MB" };
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
  const safe = sanitizeOutboundFilename(file.name);
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
