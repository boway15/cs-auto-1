import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decodeBytesWithCharset,
  decodeImapPartPayload,
  hasReadableEmailBody,
  isMimeHeadersOnlyBody,
  parseFullMime,
} from "./mime-parse.ts";

Deno.test("decodeBytesWithCharset decodes gb2312 body", () => {
  const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);
  const text = decodeBytesWithCharset(bytes, "gb2312");
  assertStringIncludes(text, "中文");
});

Deno.test("decodeBytesWithCharset prefers valid utf-8 over mislabeled charset", () => {
  const bytes = new TextEncoder().encode("hello utf-8");
  const text = decodeBytesWithCharset(bytes, "gb2312");
  assertStringIncludes(text, "hello");
});

Deno.test("parseFullMime falls back to text/html part when structured parse is empty", () => {
  const raw = [
    "From: SEDETA (Shopify) <mailer@shopify.com>",
    "Message-ID: <E1020004-18B30774C0C77A87-FAFF47F4@shopify.com>",
    "Subject: New customer message",
    "",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "<div>",
    "<p>You received a new message from your online store's contact form.</p>",
    "<strong>Country Code:</strong><br>US<br>",
    "<strong>Product:</strong><br>Product question for: https://example.com/product<br>",
    "<strong>Name:</strong><br>Trevor<br>",
    "<strong>Email:</strong><br>stweetdeals@gmail.com<br>",
    "<strong>Body:</strong><br>Is this desk reversible?",
    "</div>",
  ].join("\r\n");

  const parsed = parseFullMime(raw);

  assertStringIncludes(parsed.bodyText, "Country Code:");
  assertStringIncludes(parsed.bodyText, "Is this desk reversible?");
  assertStringIncludes(parsed.bodyHtml ?? "", "online store's contact form");
});

Deno.test("parseFullMime falls back to raw html fragment", () => {
  const parsed = parseFullMime("<div><strong>Body:</strong><br>Is this desk reversible?</div>");

  assertStringIncludes(parsed.bodyText, "Body:");
  assertStringIncludes(parsed.bodyText, "Is this desk reversible?");
  assertEquals(parsed.attachments.length, 0);
});

Deno.test("parseFullMime treats html with name= as body not attachment (Shopify)", () => {
  const qp = [
    "<table class=3D\"mail-sections\">",
    "<tr><td><strong>Country Code:</strong><br>US</td></tr>",
    "<tr><td><strong>Body:</strong><br>Is this desk reversible=3F</td></tr>",
    "</table>",
  ].join("\r\n");

  const raw = [
    "Content-Type: multipart/alternative; boundary=\"b1\"",
    "",
    "--b1",
    "Content-Type: text/html; charset=UTF-8; name=\"message.html\"",
    "Content-Transfer-Encoding: quoted-printable",
    "Content-Disposition: inline",
    "",
    qp,
    "--b1--",
  ].join("\r\n");

  const parsed = parseFullMime(raw);

  assertEquals(parsed.attachments.length, 0);
  assertStringIncludes(parsed.bodyHtml ?? "", "mail-sections");
  assertStringIncludes(parsed.bodyText, "Is this desk reversible?");
});

Deno.test("parseFullMime splits multipart/related into inline images", () => {
  const boundary = "rel1";
  const img1 = "fake-jpeg-bytes-1";
  const img2 = "fake-jpeg-bytes-2";
  const raw = [
    `Content-Type: multipart/related; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>see <img src=\"cid:image1.jpeg\"></p>",
    `--${boundary}`,
    "Content-Type: image/jpeg; name=\"image1.jpeg\"",
    "Content-Disposition: inline",
    "Content-Transfer-Encoding: 7bit",
    "",
    img1,
    `--${boundary}`,
    "Content-Type: image/jpeg; name=\"image2.jpeg\"",
    "Content-Disposition: inline",
    "Content-Transfer-Encoding: 7bit",
    "",
    img2,
    `--${boundary}--`,
  ].join("\r\n");

  const parsed = parseFullMime(raw);
  assert(parsed.attachments.length >= 2);
  const names = parsed.attachments.map((a) => a.filename);
  assertEquals(names.some((n) => n.includes("image1")), true);
  assertEquals(names.some((n) => n.includes("image2")), true);
});

Deno.test("parseFullMime does not treat multipart/alternative leaf as downloadable attachment", () => {
  const raw = [
    "Content-Type: multipart/alternative; boundary=\"b1\"",
    "Content-Disposition: attachment",
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "I'll just accept the refund",
    "--b1",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>I'll just accept the refund</p>",
    "--b1--",
  ].join("\r\n");

  const parsed = parseFullMime(raw);
  assertEquals(parsed.attachments.length, 0);
  assertStringIncludes(parsed.bodyText, "accept the refund");
});

Deno.test("parseFullMime promotes misclassified text/html attachment to body", () => {
  const html = "<html><body><p>Real order details here</p></body></html>";
  const raw = [
    "Content-Type: multipart/mixed; boundary=\"b1\"",
    "",
    "--b1",
    "Content-Type: text/plain",
    "",
    "short plain",
    "--b1",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Disposition: attachment",
    "",
    html,
    "--b1--",
  ].join("\r\n");

  const parsed = parseFullMime(raw);
  assertEquals(parsed.attachments.length, 0);
  assertStringIncludes(parsed.bodyHtml ?? "", "Real order details");
});

Deno.test("parseFullMime decodes quoted-printable body_text fragment", () => {
  const raw = [
    "You=20received=20a=20new=20message=20from=20your=20online=20store's=20contact=20form.",
    "<strong>Country Code:</strong><br>US",
  ].join("\r\n");

  const parsed = parseFullMime(raw);

  assertStringIncludes(parsed.bodyText, "You received a new message");
  assertStringIncludes(parsed.bodyText, "Country Code");
});

Deno.test("parseFullMime decodes headerless base64 BODY[TEXT] payload", () => {
  const plain = "您好，\n\n请直接回复本邮件并提供您的订单号，以便我们为您处理。\n谢谢！\n客服团队";
  const payload = btoa(unescape(encodeURIComponent(plain)));
  const parsed = parseFullMime(payload);

  assertStringIncludes(parsed.bodyText, "您好");
  assertStringIncludes(parsed.bodyText, "订单号");
  assertStringIncludes(parsed.bodyText, "客服团队");
});

Deno.test("hasReadableEmailBody treats undecoded base64 as missing", () => {
  const plain = "您好，请提供订单号";
  const payload = btoa(unescape(encodeURIComponent(plain)));
  assertEquals(hasReadableEmailBody(payload, null), false);
  assertEquals(hasReadableEmailBody(plain, null), true);
});

Deno.test("hasReadableEmailBody treats MIME headers only as missing", () => {
  const headersOnly = [
    "Content-Type: text/plain; charset=us-ascii",
    "Content-Transfer-Encoding: 7bit",
  ].join("\r\n");
  assertEquals(isMimeHeadersOnlyBody(headersOnly), true);
  assertEquals(hasReadableEmailBody(headersOnly, null), false);
});

Deno.test("parseFullMime decodes text part without blank line after headers (iCloud BODY[TEXT])", () => {
  const raw = [
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "您好，金属杆缺少螺丝配件，请协助处理。",
  ].join("\r\n");

  const parsed = parseFullMime(raw);

  assertStringIncludes(parsed.bodyText, "金属杆缺少螺丝配件");
  assertEquals(isMimeHeadersOnlyBody(parsed.bodyText), false);
});

Deno.test("parseFullMime rejects MIME headers only fragment", () => {
  const raw = [
    "Content-Type: text/plain; charset=us-ascii",
    "Content-Transfer-Encoding: 7bit",
  ].join("\r\n");

  const parsed = parseFullMime(raw);

  assertEquals(parsed.bodyText, "");
  assertEquals(parsed.bodyHtml, null);
});

Deno.test("decodeImapPartPayload decodes BASE64 body without MIME headers", () => {
  const payload = btoa("hello-att");
  const bytes = decodeImapPartPayload(`${payload}\r\n`, "BASE64");
  assert(bytes != null);
  assertEquals(new TextDecoder().decode(bytes!), "hello-att");
});

Deno.test("decodeImapPartPayload returns null for empty", () => {
  assertEquals(decodeImapPartPayload("   ", "base64"), null);
});
