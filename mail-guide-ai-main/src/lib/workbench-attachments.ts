/** 工作台附件展示：占位 vs 可下载、显示名补扩展名 */

import { isOutlookEmptyHtmlShell } from "@/lib/email-body";

const MIME_DISPLAY_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/octet-stream": ".bin",
  "text/plain": ".txt",
  "text/csv": ".csv",
};

export function isPlaceholderAttachment(item: Record<string, unknown>): boolean {
  if (typeof item.storage_path === "string" && item.storage_path.trim()) return false;
  if (typeof item.url === "string" && item.url.trim()) return false;
  return Boolean(item.note || item.count);
}

/** 占位 JSON 里 BODYSTRUCTURE 统计的附件数量（历史轻量同步未拉二进制） */
export function placeholderAttachmentCount(
  attachments: Record<string, unknown>[] | null | undefined,
): number {
  if (!Array.isArray(attachments)) return 0;
  return attachments.reduce((max, item) => {
    if (!item || typeof item !== "object") return max;
    const c = (item as Record<string, unknown>).count;
    return typeof c === "number" && c > max ? c : max;
  }, 0);
}

/** 邮件内嵌图（multipart/related、Outlook image001 等），应在正文区展示而非仅列在附件 */
export function isLikelyInlineImageAttachment(
  item: Record<string, unknown>,
  email: { body_text?: string | null; body_html?: string | null },
): boolean {
  const ct = String(item.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (!ct.startsWith("image/")) return false;
  const html = String(email.body_html ?? "");
  const fn = String(item.filename ?? "").trim();
  if (/cid:/i.test(html) && fn) {
    const base = fn.replace(/\.[a-z0-9]{2,8}$/i, "");
    const lower = html.toLowerCase();
    if (lower.includes(`cid:${fn.toLowerCase()}`) || lower.includes(`cid:${base.toLowerCase()}`)) {
      return true;
    }
  }
  if (/^image\d{3}\.(jpe?g|png|gif|webp|bmp)$/i.test(fn) && !/<img\b/i.test(html)) {
    return true;
  }
  if (/^image\d+\./i.test(fn) && isOutlookEmptyHtmlShell(html)) {
    return true;
  }
  return false;
}

export type WorkbenchAttachmentRef = {
  item: Record<string, unknown>;
  index: number;
};

export function partitionWorkbenchAttachments(
  attachments: Record<string, unknown>[] | null | undefined,
  email: { body_text?: string | null; body_html?: string | null },
): { inlineImages: WorkbenchAttachmentRef[]; fileAttachments: WorkbenchAttachmentRef[] } {
  const list = Array.isArray(attachments) ? attachments : [];
  const inlineImages: WorkbenchAttachmentRef[] = [];
  const fileAttachments: WorkbenchAttachmentRef[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i]!;
    const ref = { item, index: i };
    if (isPlaceholderAttachment(item) || !isLikelyInlineImageAttachment(item, email)) {
      fileAttachments.push(ref);
    } else {
      inlineImages.push(ref);
    }
  }
  return { inlineImages, fileAttachments };
}

export function displayAttachmentFilename(item: Record<string, unknown>): string {
  let name = String(item.filename ?? "附件").trim() || "附件";
  if (!/\.[a-z0-9]{2,8}$/i.test(name)) {
    const ct = String(item.contentType ?? "").split(";")[0].trim().toLowerCase();
    const ext = MIME_DISPLAY_EXT[ct];
    if (ext) name = `${name}${ext}`;
  }
  return name;
}
