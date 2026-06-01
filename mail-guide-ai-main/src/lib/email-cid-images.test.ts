import { describe, expect, it } from "vitest";
import {
  buildCidToAttachmentUrlMap,
  normalizeContentId,
  replaceCidImagesInHtml,
  resolveCidImagesInEmailHtml,
} from "./email-cid-images";

describe("email-cid-images", () => {
  it("normalizes content-id with angle brackets and cid prefix", () => {
    expect(normalizeContentId("cid:<image1.jpeg>")).toBe("image1.jpeg");
    expect(normalizeContentId("mf_ABC/L0/001")).toBe("mf_abc/l0/001");
  });

  it("maps by contentId metadata", () => {
    const html = '<img src="cid:mf_abc/l0/001" alt="photo.jpg">';
    const attachments = [
      {
        filename: "photo.jpg",
        contentType: "image/jpeg",
        contentId: "mf_ABC/L0/001",
      },
    ];
    const map = buildCidToAttachmentUrlMap(html, attachments, { 0: "https://cdn/a.jpg" });
    expect(map.get("mf_abc/l0/001")).toBe("https://cdn/a.jpg");
  });

  it("maps by img alt to attachment filename", () => {
    const html = '<img alt="image0.jpeg" src="cid:mf_unknown">';
    const attachments = [{ filename: "image0.jpeg", contentType: "image/jpeg" }];
    const out = resolveCidImagesInEmailHtml(html, attachments, { 0: "https://cdn/img0.jpg" });
    expect(out).toContain('src="https://cdn/img0.jpg"');
    expect(out).not.toContain("cid:");
  });

  it("replaces cid src in HTML", () => {
    const map = new Map([["foo.png", "https://x/y.png"]]);
    const html = '<img src="cid:foo.png">';
    expect(replaceCidImagesInHtml(html, map)).toBe('<img src="https://x/y.png">');
  });
});
