import { describe, expect, it } from "vitest";
import {
  buildCidToAttachmentUrlMap,
  normalizeContentId,
} from "./email-cid-images";
import {
  dedupeRepeatedPlainBody,
  enrichedEmailTextToDisplayHtml,
  isAppleMailEnrichedText,
  normalizeInlineImageReferences,
  pickBestEnrichedBodySource,
} from "./email-enriched-text";

describe("email-enriched-text", () => {
  it("detects Apple Mail enriched text", () => {
    expect(isAppleMailEnrichedText("Hello [cid:abc.png] world")).toBe(true);
    expect(isAppleMailEnrichedText('Warranty<https://example.com>')).toBe(true);
    expect(isAppleMailEnrichedText("<div>real html</div>")).toBe(false);
  });

  it("dedupes collapsed + formatted duplicate body", () => {
    const collapsed = "Also according to your website this falls under warranty.";
    const formatted = "Also according to your website this falls under warranty.\n\nJames Berger\n408-836-1689";
    const combined = `${collapsed}\n\n${formatted}`;
    const out = dedupeRepeatedPlainBody(combined);
    expect(out).toContain("\n");
    expect(out).toContain("James Berger");
  });

  it("converts bracket cid and autolinks to HTML", () => {
    const raw = "See [cid:foo.png] and Warranty<https://example.com/warranty>";
    const html = enrichedEmailTextToDisplayHtml(
      raw,
      [{ filename: "foo.png", contentType: "image/png", contentId: "foo.png" }],
      { 0: "https://cdn/foo.png" },
    );
    expect(html).toContain('src="https://cdn/foo.png"');
    expect(html).toContain('href="https://example.com/warranty"');
    expect(html).not.toContain("[cid:");
  });

  it("maps bracket cid by contentId uuid", () => {
    const attachments = [
      {
        filename: "1200x628_1.jpg",
        contentType: "image/jpeg",
        contentId: "6EFF3F5C-D981-4B32-83EF-C99D19867FF0",
      },
    ];
    const map = buildCidToAttachmentUrlMap(
      '[cid:6EFF3F5C-D981-4B32-83EF-C99D19867FF0]',
      attachments,
      { 0: "https://cdn/warranty.jpg" },
    );
    expect(map.get(normalizeContentId("cid:6EFF3F5C-D981-4B32-83EF-C99D19867FF0"))).toBe(
      "https://cdn/warranty.jpg",
    );
  });

  it("prefers better formatted body_text over collapsed body_html", () => {
    const collapsed = "Also according to your website this falls under warranty. [cid:foo.png]";
    const formatted = "Also according to your website this falls under warranty.\n\nJames Berger\n408-836-1689\n[cid:foo.png]";
    const picked = pickBestEnrichedBodySource(formatted, collapsed);
    expect(picked).toContain("\n");
  });

  it("shows loading placeholder when cid url not ready", () => {
    const html = enrichedEmailTextToDisplayHtml("Photo [cid:missing.png]", [], {});
    expect(html).toContain("图片加载中");
    expect(html).not.toContain("[cid:missing.png]");
  });

  it("converts angle-bracket image filenames to img tags", () => {
    const raw = "icons\n<bluesky_05837db5-f404-4503-a2d9-14f3a3fb0058.png>";
    const html = enrichedEmailTextToDisplayHtml(
      raw,
      [{
        filename: "bluesky_05837db5-f404-4503-a2d9-14f3a3fb0058.png",
        contentType: "image/png",
      }],
      { 0: "https://cdn/bluesky.png" },
    );
    expect(html).toContain('src="https://cdn/bluesky.png"');
    expect(html).not.toContain("<bluesky_");
  });

  it("normalizes angle brackets to bracket cid", () => {
    expect(normalizeInlineImageReferences("<foo.png>")).toBe("[cid:foo.png]");
    expect(normalizeInlineImageReferences("<service@x.com>")).toBe("<service@x.com>");
  });
});
