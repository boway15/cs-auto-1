/** 将 HTML 邮件中的 cid: 内嵌图替换为可访问的签名 URL */

export function normalizeContentId(cid: string): string {
  return cid
    .replace(/^cid:/i, "")
    .replace(/^<|>$/g, "")
    .trim()
    .toLowerCase();
}

function attachmentContentId(item: Record<string, unknown>): string | null {
  const raw = item.contentId ?? item.content_id;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return normalizeContentId(raw);
}

function attachmentFilename(item: Record<string, unknown>): string {
  return String(item.filename ?? "").trim().toLowerCase();
}

function isImageAttachment(item: Record<string, unknown>): boolean {
  const ct = String(item.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (ct.startsWith("image/")) return true;
  const fn = attachmentFilename(item);
  return /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(fn);
}

function findAttachmentIndexForCidKey(
  cidKey: string,
  attachments: Record<string, unknown>[],
  previewUrls: Record<number, string>,
): number {
  const key = normalizeContentId(cidKey);
  if (!key) return -1;

  for (let i = 0; i < attachments.length; i++) {
    if (!previewUrls[i]) continue;
    const att = attachments[i]!;
    const storedCid = attachmentContentId(att);
    if (storedCid && storedCid === key) return i;
    const fn = attachmentFilename(att);
    if (fn && (key === fn || key === fn.replace(/\.[a-z0-9]{2,8}$/i, ""))) return i;
    if (storedCid && (storedCid.endsWith(key) || key.endsWith(storedCid))) return i;
    if (fn && (key.includes(fn) || fn.includes(key))) return i;
  }
  return -1;
}

/** 从正文 HTML 与附件列表构建 cid → 预览 URL 映射 */
export function buildCidToAttachmentUrlMap(
  html: string,
  attachments: Record<string, unknown>[],
  previewUrls: Record<number, string>,
): Map<string, string> {
  const map = new Map<string, string>();

  attachments.forEach((att, i) => {
    const url = previewUrls[i];
    if (!url) return;
    const cid = attachmentContentId(att);
    if (cid) map.set(cid, url);
  });

  attachments.forEach((att, i) => {
    const url = previewUrls[i];
    if (!url) return;
    const fn = attachmentFilename(att);
    if (!fn) return;
    const base = fn.replace(/\.[a-z0-9]{2,8}$/i, "");
    map.set(normalizeContentId(`cid:${fn}`), url);
    if (base) map.set(normalizeContentId(`cid:${base}`), url);
  });

  for (const m of html.matchAll(/\[cid:([^\]]+)\]/gi)) {
    const key = normalizeContentId(`cid:${m[1] ?? ""}`);
    if (!key || map.has(key)) continue;
    const idx = findAttachmentIndexForCidKey(key, attachments, previewUrls);
    if (idx >= 0) map.set(key, previewUrls[idx]!);
  }

  for (const m of html.matchAll(/<([a-zA-Z0-9_().-]+\.(?:png|jpe?g|gif|webp|bmp|svg))>/gi)) {
    const key = normalizeContentId(`cid:${m[1] ?? ""}`);
    if (!key || map.has(key)) continue;
    const idx = findAttachmentIndexForCidKey(key, attachments, previewUrls);
    if (idx >= 0) map.set(key, previewUrls[idx]!);
  }

  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const srcMatch = tag.match(/\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
    const src = srcMatch?.[1] ?? srcMatch?.[2] ?? "";
    if (!/^cid:/i.test(src)) continue;
    const key = normalizeContentId(src);
    if (map.has(key)) continue;
    const altMatch = tag.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const alt = (altMatch?.[1] ?? altMatch?.[2] ?? "").trim().toLowerCase();
    if (!alt) continue;
    const attIdx = attachments.findIndex((a, idx) => {
      if (!previewUrls[idx]) return false;
      const fn = attachmentFilename(a);
      return fn === alt || fn.endsWith(`/${alt}`) || fn.endsWith(alt);
    });
    if (attIdx >= 0) map.set(key, previewUrls[attIdx]!);
  }

  const remainingCids: string[] = [];
  const cidPatterns = [
    /\bsrc\s*=\s*(?:"(cid:[^"]+)"|'(cid:[^']+)')/gi,
    /\[cid:([^\]]+)\]/gi,
    /(?<![\w/"'=])cid:([^\s<>\[\]"']+)/gi,
  ];
  for (const cidRe of cidPatterns) {
    let cm: RegExpExecArray | null;
    while ((cm = cidRe.exec(html)) !== null) {
      const raw = cm[1] ?? cm[2] ?? "";
      const key = normalizeContentId(raw.startsWith("cid:") ? raw : `cid:${raw}`);
      if (key && !map.has(key)) remainingCids.push(key);
    }
  }

  const usedUrls = new Set(map.values());
  const imageIndexes = attachments
    .map((a, i) => ({ a, i }))
    .filter(({ a, i }) => Boolean(previewUrls[i]) && isImageAttachment(a));

  let seq = 0;
  for (const cid of remainingCids) {
    while (seq < imageIndexes.length) {
      const { i } = imageIndexes[seq++]!;
      const url = previewUrls[i]!;
      if (!usedUrls.has(url)) {
        map.set(cid, url);
        usedUrls.add(url);
        break;
      }
    }
  }

  return map;
}

/** 将 HTML 中 img src="cid:..." 替换为实际 URL */
export function replaceCidImagesInHtml(html: string, cidToUrl: Map<string, string>): string {
  if (!cidToUrl.size) return html;
  return html.replace(
    /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|(cid:[^\s>]+))/gi,
    (full, dq, sq, unquoted) => {
      const src = dq ?? sq ?? unquoted ?? "";
      if (!/^cid:/i.test(src)) return full;
      const url = cidToUrl.get(normalizeContentId(src));
      if (!url) return full;
      return `src="${url}"`;
    },
  );
}

export function resolveCidImagesInEmailHtml(
  html: string,
  attachments: Record<string, unknown>[] | null | undefined,
  previewUrls: Record<number, string>,
): string {
  if (!html || !/cid:/i.test(html)) return html;
  const list = Array.isArray(attachments) ? attachments : [];
  const map = buildCidToAttachmentUrlMap(html, list, previewUrls);
  return replaceCidImagesInHtml(html, map);
}
