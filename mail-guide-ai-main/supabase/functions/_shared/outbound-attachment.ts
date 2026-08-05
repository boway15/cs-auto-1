export type OutboundAttachmentInput = {
  storage_path: string;
  filename: string;
  content_type: string;
};

const MAX_FILES = 5;
const MAX_FILE = 35 * 1024 * 1024;
const MAX_TOTAL = 100 * 1024 * 1024;
export const OUTBOUND_BUCKET = "outbound-attachments";

type StorageBucket = {
  download: (path: string) => Promise<{ data: Blob | null; error: unknown }>;
  copy: (
    fromPath: string,
    toPath: string,
  ) => Promise<{ data: { path: string } | null; error: unknown }>;
  upload: (
    path: string,
    body: Blob | ArrayBuffer | Uint8Array,
    opts?: { contentType?: string; upsert?: boolean },
  ) => Promise<{ error: unknown }>;
  remove: (paths: string[]) => Promise<{ error: unknown }>;
};

type StorageAdmin = {
  storage: {
    from: (bucket: string) => StorageBucket;
  };
};

/** Storage 对象 key 片段：仅 ASCII */
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

/** 发送成功后归档路径：sent/{mailbox_id}/{send_log_id}/{uuid}_{safe} */
export function buildSentArchivePath(
  mailboxId: string,
  sendLogId: string,
  filename: string,
): string {
  const safe = sanitizeOutboundStorageKeySegment(filename);
  return `sent/${mailboxId}/${sendLogId}/${crypto.randomUUID()}_${safe}`;
}

export async function loadOutboundAttachments(
  admin: StorageAdmin,
  userId: string,
  inputs: OutboundAttachmentInput[] | null | undefined,
): Promise<{ filename: string; contentType: string; content: Uint8Array }[]> {
  if (!inputs?.length) return [];
  if (inputs.length > MAX_FILES) {
    throw new Error(`附件数量不能超过 ${MAX_FILES} 个`);
  }

  const out: { filename: string; contentType: string; content: Uint8Array }[] = [];
  let total = 0;
  const prefix = `${userId}/`;

  for (const item of inputs) {
    if (!item.storage_path?.startsWith(prefix)) {
      throw new Error("无权使用该附件");
    }
    const { data, error } = await admin.storage
      .from(OUTBOUND_BUCKET)
      .download(item.storage_path);
    if (error || !data) {
      throw new Error(`读取附件失败: ${item.filename}`);
    }
    const buf = new Uint8Array(await data.arrayBuffer());
    if (buf.byteLength > MAX_FILE) {
      throw new Error(`单文件不能超过 ${MAX_FILE / 1024 / 1024}MB`);
    }
    total += buf.byteLength;
    if (total > MAX_TOTAL) {
      throw new Error(`附件总大小不能超过 ${MAX_TOTAL / 1024 / 1024}MB`);
    }
    out.push({
      filename: item.filename,
      contentType: item.content_type || "application/octet-stream",
      content: buf,
    });
  }
  return out;
}

async function copyOrUpload(
  bucket: StorageBucket,
  fromPath: string,
  toPath: string,
  contentType: string,
): Promise<void> {
  const copied = await bucket.copy(fromPath, toPath);
  if (!copied.error) return;

  const { data, error } = await bucket.download(fromPath);
  if (error || !data) {
    throw new Error(`归档复制失败: ${fromPath}`);
  }
  const uploaded = await bucket.upload(toPath, data, {
    contentType: contentType || undefined,
    upsert: false,
  });
  if (uploaded.error) {
    throw new Error(`归档上传失败: ${toPath}`);
  }
}

/**
 * 将临时出站附件复制到 sent/ 归档路径；返回更新后的 metadata 列表。
 * 单文件失败时保留原 storage_path，不中断其余文件。
 */
export async function archiveOutboundAttachments(
  admin: StorageAdmin,
  mailboxId: string,
  sendLogId: string,
  inputs: OutboundAttachmentInput[],
): Promise<OutboundAttachmentInput[]> {
  if (!inputs.length) return [];

  const bucket = admin.storage.from(OUTBOUND_BUCKET);
  const archived: OutboundAttachmentInput[] = [];

  for (const item of inputs) {
    const dest = buildSentArchivePath(mailboxId, sendLogId, item.filename);
    try {
      await copyOrUpload(bucket, item.storage_path, dest, item.content_type);
      archived.push({
        filename: item.filename,
        content_type: item.content_type,
        storage_path: dest,
      });
    } catch (e) {
      console.warn("outbound attachment archive failed:", item.storage_path, e);
      archived.push(item);
    }
  }

  return archived;
}

export async function removeOutboundTempAttachments(
  admin: StorageAdmin,
  inputs: OutboundAttachmentInput[],
): Promise<void> {
  for (const a of inputs) {
    if (!a.storage_path || a.storage_path.startsWith("sent/")) continue;
    try {
      await admin.storage.from(OUTBOUND_BUCKET).remove([a.storage_path]);
    } catch (e) {
      console.warn("outbound attachment cleanup failed:", a.storage_path, e);
    }
  }
}
