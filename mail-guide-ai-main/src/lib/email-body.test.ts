import { describe, expect, it } from "vitest";
import {
  decodePlainTextEntities,
  decodeQuotedPrintableLoose,
  formatPlainTextEmailForDisplay,
  formatGmailCollapsedPlainBody,
  isEmailBodyEmpty,
  isGmailCollapsedPlainBody,
  isGmailStructuredHtml,
  isOutlookEmptyHtmlShell,
  looksLikeHtmlEmailContent,
  normalizeEmailBodyForDisplay,
  pickRenderableEmailBody,
  plainTextNotRepresentedInHtml,
  plainTextEmailToDisplayHtml,
  splitPlainEmailTopAndQuoted,
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

describe("pickRenderableEmailBody", () => {
  it("Outlook Word 空壳 HTML 时回退 body_text", () => {
    const wordShell =
      '<html xmlns:v="urn:schemas-microsoft-com:vml"><head><meta name=Generator content="Microsoft Word 15"></head><body lang=EN-US><div class=WordSection1><p class=MsoNormal>&nbsp;</p></div></body></html>';
    const plain =
      "Amazon, sorry for the delay, we moved and I was just able to put this together";
    expect(isOutlookEmptyHtmlShell(wordShell)).toBe(true);
    const picked = pickRenderableEmailBody(plain, wordShell);
    expect(picked.html).toBeNull();
    expect(picked.text).toContain("sorry for the delay");
  });

  it("有可读 HTML 时仍优先 HTML", () => {
    const html = "<p>Hello <strong>world</strong></p>";
    const picked = pickRenderableEmailBody("Hello world", html);
    expect(picked.html).toContain("<strong>world</strong>");
  });

  it("HTML 未包含 body_text 开头时回退纯文本（Outlook 转发）", () => {
    const wordShell =
      '<html xmlns:v="urn:schemas-microsoft-com:vml"><head><meta name=Generator content="Microsoft Word 15"></head><body><p class=MsoNormal>Styles only ' +
      "x".repeat(200) +
      "</p></body></html>";
    const plain =
      "Amazon, sorry for the delay, we moved\nFrom: SEDETA Service <service@sedetalife.com>";
    expect(plainTextNotRepresentedInHtml(plain, wordShell)).toBe(true);
    const picked = pickRenderableEmailBody(plain, wordShell);
    expect(picked.html).toBeNull();
    expect(picked.text).toContain("sorry for the delay");
    expect(picked.text).toContain("<service@sedetalife.com>");
  });
});

describe("decodePlainTextEntities", () => {
  it("保留尖括号邮箱地址，仅解码实体", () => {
    const raw =
      "From: SEDETA Service <service@sedetalife.com> &amp; pdballou <pdballou@cox.net>";
    expect(decodePlainTextEntities(raw)).toBe(
      "From: SEDETA Service <service@sedetalife.com> & pdballou <pdballou@cox.net>",
    );
  });
});

describe("formatPlainTextEmailForDisplay", () => {
  const collapsed =
    "Amazon, sorry for the delay, we moved and I was just able to put this together   From: SEDETA Service <service@sedetalife.com> Sent: Sunday, May 24, 2026 7:57 PMTo: pdballou <pdballou@cox.net>Subject: RE: request to replace defective part Dear customer,Thank you for contacting us.I used your email to search in the order on our official website, but did not find the relevant information of your order. In order to better help you solve the problem, can you tell me which platform you purchased our products and what is your order number?Thank you for your understanding and support. Looking forward to your reply.    	SEDETA Serviceservice@sedetalife.com <mailto:service@sedetalife.com>    Original:*	From：pdballou<pdballou@cox.net> *	Date：2026-05-25 00:01:16*	Subject：RE: request to replace defective part  From: pdballou@cox.net Sent: Thursday, May 21, 2026 5:55 AMTo: service@sedetalife.com Subject: request to replace defective partImportance: High Greetings,  I need some support";

  it("恢复邮件头换行与段落", () => {
    const out = formatPlainTextEmailForDisplay(collapsed);
    expect(out).toContain("Amazon, sorry for the delay");
    expect(out).toMatch(/\n\nFrom:\s*SEDETA Service/i);
    expect(out).toMatch(/7:57 PM\nTo:/i);
    expect(out).toMatch(/\nSubject:\s*RE: request to replace defective part[\s\n]+Dear customer,/i);
    expect(out).toMatch(/customer,\n\nThank you/i);
    expect(out).toContain("Original:");
    expect(out).toMatch(/Importance: High[\s\n]+Greetings,/i);
  });

  it("最新回复与引用线程分离", () => {
    const out = formatPlainTextEmailForDisplay(collapsed);
    const { top, quoted } = splitPlainEmailTopAndQuoted(out);
    expect(top).toContain("sorry for the delay");
    expect(top).not.toContain("Dear customer");
    expect(quoted).toMatch(/From:\s*SEDETA Service/i);
    expect(quoted).toContain("Greetings,");
  });
});

describe("Gmail 邮件适配", () => {
  const gmailHtml =
    '<div dir="auto"><div>$200 refund please.</div><div class="gmail_quote"><div class="gmail_attr">On Tue, May 26, 2026 wrote:<br></div><blockquote class="gmail_quote"><p>We sincerely apologize</p></blockquote></div></div>';
  const gmailPlainCollapsed =
    "$200 refund please.*Dustin Davey*Founder | Dūstar Apparel📧 dustarapparel@gmail.com🌐 dustarapparel.comOn Tue, May 26, 2026, 02:58 SEDETA Service <service@sedetalife.com> wrote:> We sincerely apologize for any inconvenience caused.>> You sent us your order cancellation";

  it("识别 Gmail HTML 并优先渲染", () => {
    expect(isGmailStructuredHtml(gmailHtml)).toBe(true);
    expect(plainTextNotRepresentedInHtml(gmailPlainCollapsed, gmailHtml)).toBe(false);
    const picked = pickRenderableEmailBody(gmailPlainCollapsed, gmailHtml);
    expect(picked.html).toContain("gmail_quote");
    expect(picked.html).toContain("$200 refund please");
  });

  it("压扁 Gmail 纯文本恢复换行与引用分割", () => {
    expect(isGmailCollapsedPlainBody(gmailPlainCollapsed)).toBe(true);
    const out = formatPlainTextEmailForDisplay(gmailPlainCollapsed);
    expect(out).toMatch(/\$200 refund please/);
    expect(out).toMatch(/dustarapparel\.com\n\nOn Tue/i);
    expect(out).toMatch(/wrote:\n> We sincerely/i);
    const { top, quoted } = splitPlainEmailTopAndQuoted(out);
    expect(top).toContain("$200 refund please");
    expect(top).toContain("Dustin Davey");
    expect(quoted).toMatch(/On Tue, May 26/i);
    expect(quoted).toContain("We sincerely apologize");
    const html = plainTextEmailToDisplayHtml(out);
    expect(html).toContain("email-gmail-attr");
    expect(html).toContain("We sincerely apologize");
    expect(html).not.toMatch(/&gt;\s*We sincerely/i);
  });
});
