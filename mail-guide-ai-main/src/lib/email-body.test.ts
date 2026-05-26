import { describe, expect, it } from "vitest";
import {
  decodeQuotedPrintableLoose,
  isEmailBodyEmpty,
  looksLikeHtmlEmailContent,
  normalizeEmailBodyForDisplay,
} from "@/lib/email-body";

describe("isEmailBodyEmpty", () => {
  it("text 与 html 皆空时返回 true", () => {
    expect(isEmailBodyEmpty({ body_text: null, body_html: null })).toBe(true);
    expect(isEmailBodyEmpty({ body_text: "  ", body_html: "" })).toBe(true);
  });

  it("有 text 或 html 时返回 false", () => {
    expect(isEmailBodyEmpty({ body_text: "hello", body_html: null })).toBe(false);
    expect(isEmailBodyEmpty({ body_text: "", body_html: "<p>x</p>" })).toBe(false);
  });
});

describe("normalizeEmailBodyForDisplay", () => {
  it("解码 body_text 中的 quoted-printable 并识别 HTML", () => {
    const qp =
      "You=20received=20a=20new=20message.<table><tr><td><strong>Body:</strong>Is this desk reversible=3F</td></tr></table>";
    const n = normalizeEmailBodyForDisplay(qp, null);
    expect(n.text).toContain("You received a new message");
    expect(n.html).toContain("<table>");
    expect(n.text).toContain("Is this desk reversible?");
  });

  it("decodeQuotedPrintableLoose 解码 =20", () => {
    expect(decodeQuotedPrintableLoose("hello=20world")).toBe("hello world");
  });

  it("body_text 为 Gmail HTML 时提升为 html 渲染", () => {
    const html =
      '<div dir="auto">Dear customer service representative,</div><div>I need a return label.</div>';
    const n = normalizeEmailBodyForDisplay(html, null);
    expect(n.html).toContain("Dear customer service representative");
    expect(n.text).toContain("Dear customer service representative");
    expect(looksLikeHtmlEmailContent(html)).toBe(true);
  });
});
