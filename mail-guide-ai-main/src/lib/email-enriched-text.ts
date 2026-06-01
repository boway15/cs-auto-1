import {
  formatPlainTextEmailForDisplay,
  splitPlainEmailTopAndQuoted,
} from "@/lib/email-body";
import {
  buildCidToAttachmentUrlMap,
  normalizeContentId,
} from "@/lib/email-cid-images";

/** 正文是否含 cid 图片引用（HTML img、方括号、尖括号文件名或裸 cid:） */
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

const INLINE_IMAGE_ANGLE_RE = /<([a-zA-Z0-9_().-]+\.(?:png|jpe?g|gif|webp|bmp|svg))>/gi;

/** Apple Mail 富文本里 <logo.png> 与 [cid:logo.png] 统一为方括号 cid 便于映射 */
export function normalizeInlineImageReferences(text: string): string {
  return text.replace(INLINE_IMAGE_ANGLE_RE, (_m, filename: string) => `[cid:${filename}]`);
}

function mergeMissingCidsFromCollapsedPart(collapsed: string, formatted: string): string {
  const mainCollapsed = collapsed.split(/\n\nOn\s+/i)[0] ?? collapsed;
  const cidTags = [...mainCollapsed.matchAll(/\[cid:([^\]]+)\]/gi)];
  if (cidTags.length === 0) return formatted;

  let merged = formatted;
  for (const m of cidTags) {
    const tag = m[0]!;
    const fn = m[1]!;
    const fnLower = fn.toLowerCase();
    if (
      merged.includes(tag) ||
      merged.toLowerCase().includes(`<${fnLower}>`) ||
      merged.toLowerCase().includes(`cid:${fnLower}`)
    ) {
      continue;
    }
    const anchor = /pawn me off to Amazon\s*/i;
    if (anchor.test(merged)) {
      merged = merged.replace(anchor, (hit) => `${hit}${tag}\n`);
      continue;
    }
    const topBreak = merged.indexOf("\n\n");
    merged = topBreak > 0 ? `${merged.slice(0, topBreak)}\n${tag}${merged.slice(topBreak)}` : `${merged}\n${tag}`;
  }
  return merged;
}

/** 在 body_text / body_html 中选排版更好的 Apple 富文本源 */
export function pickBestEnrichedBodySource(
  bodyText: string | null | undefined,
  bodyHtml: string | null | undefined,
): string | null {
  const candidates = [bodyText, bodyHtml]
    .filter((s): s is string => Boolean(s?.trim()) && isAppleMailEnrichedText(s))
    .map((s) => dedupeRepeatedPlainBody(s.trim()));
  if (candidates.length === 0) return null;
  return candidates.sort(
    (a, b) => (b.match(/\n/g)?.length ?? 0) - (a.match(/\n/g)?.length ?? 0),
  )[0]!;
}

/** Apple Mail / 部分客户端导出的「伪 HTML」：含 [cid:…]、<file.png> 或 Label<url>，无真正 HTML 标签 */
export function isAppleMailEnrichedText(s: string | null | undefined): boolean {
  const raw = s?.trim() ?? "";
  if (!raw) return false;
  if (/\[cid:[^\]]+\]/i.test(raw)) return true;
  if (/<[a-z0-9_().-]+\.(?:png|jpe?g|gif|webp|bmp|svg)>/i.test(raw)) return true;
  if (/<https?:\/\/[^>]+>/i.test(raw) && !/<(div|p|table|html|body|span)\b/i.test(raw)) {
    return true;
  }
  if (/<mailto:[^>]+>/i.test(raw) && !/<(div|p|table|html|body|span)\b/i.test(raw)) {
    return true;
  }
  return false;
}

/** 历史同步偶发把压扁版与换行版正文拼接在一起，保留换行更完整的一段 */
export function dedupeRepeatedPlainBody(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 160) return trimmed;

  const head = trimmed.slice(0, Math.min(72, trimmed.length));
  const second = trimmed.indexOf(head, head.length);
  if (second < 80) return trimmed;

  const firstPart = trimmed.slice(0, second).trim();
  const secondPart = trimmed.slice(second).trim();
  const nl1 = (firstPart.match(/\n/g) ?? []).length;
  const nl2 = (secondPart.match(/\n/g) ?? []).length;
  if (nl2 > nl1 + 2) return mergeMissingCidsFromCollapsedPart(firstPart, secondPart);
  if (nl1 > nl2 + 2) return firstPart;
  return secondPart.length > firstPart.length ? secondPart : firstPart;
}

function escapeHtmlForEmailDisplay(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

type HtmlToken = { type: "text"; value: string } | { type: "html"; value: string };

function tokenizeEnrichedPlainBlock(
  block: string,
  cidToUrl: Map<string, string>,
): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  const combined =
    /\[cid:([^\]]+)\]|(?<![\w/"'=])cid:([^\s<>\[\]"']+)|<([a-zA-Z0-9_().-]+\.(?:png|jpe?g|gif|webp|bmp|svg))>|([^\s<>\[\]\n]{1,200})<(https?:\/\/[^>\s]+)>|([^\s<>\[\]\n]{1,200})<(mailto:[^>]+)>|([^\s<>\[\]\n]{1,80})<tel:([^>]+)>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = combined.exec(block)) !== null) {
    if (m.index > last) {
      tokens.push({ type: "text", value: block.slice(last, m.index) });
    }
    const bracketCid = m[1] ?? m[2] ?? m[3];
    if (bracketCid) {
      const url = cidToUrl.get(normalizeContentId(`cid:${bracketCid}`));
      if (url) {
        tokens.push({
          type: "html",
          value: `<img src="${escapeHtmlAttr(url)}" alt="${escapeHtmlAttr(bracketCid)}" class="email-inline-cid-img" />`,
        });
      } else {
        tokens.push({
          type: "html",
          value: `<span class="email-cid-pending inline-block text-xs text-muted-foreground border border-dashed rounded px-2 py-1 my-1" title="${escapeHtmlAttr(bracketCid)}">图片加载中…</span>`,
        });
      }
    } else if (m[4] && m[5]) {
      tokens.push({
        type: "html",
        value: `<a href="${escapeHtmlAttr(m[5])}" target="_blank" rel="noreferrer">${escapeHtmlForEmailDisplay(m[4])}</a>`,
      });
    } else if (m[6] && m[7]) {
      tokens.push({
        type: "html",
        value: `<a href="${escapeHtmlAttr(m[7])}">${escapeHtmlForEmailDisplay(m[6])}</a>`,
      });
    } else if (m[8] && m[9]) {
      const tel = `tel:${m[9]}`;
      tokens.push({
        type: "html",
        value: `<a href="${escapeHtmlAttr(tel)}">${escapeHtmlForEmailDisplay(m[8])}</a>`,
      });
    }
    last = m.index + m[0].length;
  }
  if (last < block.length) tokens.push({ type: "text", value: block.slice(last) });
  return tokens;
}

function enrichedBlockToHtml(block: string, cidToUrl: Map<string, string>): string {
  const tokens = tokenizeEnrichedPlainBlock(block, cidToUrl);
  return tokens
    .map((t) =>
      t.type === "html" ? t.value : escapeHtmlForEmailDisplay(t.value).replace(/\n/g, "<br>\n"),
    )
    .join("");
}

/** 将 Apple Mail 富文本 / 含 [cid:] 的纯文本转为可展示 HTML */
export function enrichedEmailTextToDisplayHtml(
  raw: string,
  attachments: Record<string, unknown>[] | null | undefined,
  previewUrls: Record<number, string>,
): string {
  const deduped = dedupeRepeatedPlainBody(raw);
  const normalized = normalizeInlineImageReferences(deduped);
  const formatted = formatPlainTextEmailForDisplay(normalized);
  const pseudoHtml = formatted
    .replace(/\[cid:([^\]]+)\]/gi, (_, cid: string) => `src="cid:${cid}"`)
    .replace(/(?<![\w/"'=])cid:([^\s<>\[\]"']+)/gi, (_, cid: string) => `src="cid:${cid}"`);
  const cidToUrl = buildCidToAttachmentUrlMap(
    pseudoHtml,
    Array.isArray(attachments) ? attachments : [],
    previewUrls,
  );

  const { top, quoted } = splitPlainEmailTopAndQuoted(formatted);
  const main = enrichedBlockToHtml(top, cidToUrl);
  if (!quoted) return `<div class="email-plain-main">${main}</div>`;

  const attrMatch = quoted.match(
    /^On\s+.+?,\s+.+?\s+wrote:\s*(?:\n|$)/is,
  );
  if (attrMatch) {
    const attr = attrMatch[0]!.trim();
    const body = quoted.slice(attrMatch[0]!.length).trim();
    return (
      `<div class="email-plain-main">${main}</div>` +
      `<div class="email-gmail-attr text-muted-foreground text-xs mt-3 mb-1">${escapeHtmlForEmailDisplay(attr)}</div>` +
      `<blockquote class="email-plain-quote">${enrichedBlockToHtml(body, cidToUrl)}</blockquote>`
    );
  }

  return (
    `<div class="email-plain-main">${main}</div>` +
    `<blockquote class="email-plain-quote">${enrichedBlockToHtml(quoted, cidToUrl)}</blockquote>`
  );
}
