export type OutboundAttachmentInput = {
  storage_path: string;
  filename: string;
  content_type: string;
};

const MAX_FILES = 5;
const MAX_TOTAL = 25 * 1024 * 1024;

type StorageAdmin = {
  storage: {
    from: (bucket: string) => {
      download: (path: string) => Promise<{ data: Blob | null; error: unknown }>;
    };
  };
};

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
      .from("outbound-attachments")
      .download(item.storage_path);
    if (error || !data) {
      throw new Error(`读取附件失败: ${item.filename}`);
    }
    const buf = new Uint8Array(await data.arrayBuffer());
    total += buf.byteLength;
    if (total > MAX_TOTAL) {
      throw new Error("附件总大小超过限制");
    }
    out.push({
      filename: item.filename,
      contentType: item.content_type || "application/octet-stream",
      content: buf,
    });
  }
  return out;
}
