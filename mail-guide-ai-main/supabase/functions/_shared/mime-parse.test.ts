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

Deno.test("hasReadableEmailBody treats truncated MIME header fragment as missing", () => {
  const truncated = [
    "charset=us-ascii",
    "Content-Transfer-Encoding: 7bit",
  ].join("\r\n");
  assertEquals(isMimeHeadersOnlyBody(truncated), true);
  assertEquals(hasReadableEmailBody(truncated, null), false);
});

Deno.test("hasReadableEmailBody treats folded MIME headers as missing", () => {
  const folded =
    "Content-Type: text/plain;\r\n\tcharset=us-ascii\r\nContent-Transfer-Encoding: 7bit";
  assertEquals(isMimeHeadersOnlyBody(folded), true);
  assertEquals(hasReadableEmailBody(folded, null), false);
  const parsed = parseFullMime(folded);
  assertEquals(parsed.bodyText, "");
  assertEquals(parsed.bodyHtml, null);
});

Deno.test("isMimeHeadersOnlyBody rejects real content mixed with metadata", () => {
  const mixed = [
    "Content-Type: text/plain; charset=UTF-8",
    "Hello, my dresser arrived damaged.",
  ].join("\r\n");
  assertEquals(isMimeHeadersOnlyBody(mixed), false);
});

Deno.test("parseFullMime rejects truncated MIME header fragment", () => {
  const raw = [
    "charset=us-ascii",
    "Content-Transfer-Encoding: 7bit",
  ].join("\r\n");

  const parsed = parseFullMime(raw);

  assertEquals(parsed.bodyText, "");
  assertEquals(parsed.bodyHtml, null);
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

Deno.test("parseFullMime prefers substantial plain over trailing iPhone signature part", () => {
  const full = [
    "Hello,",
    "",
    "We placed (2) separate orders on 7/19/2026. Please review and respond:",
    "Order name: Jesse Harris",
    "Address: 302 W 5th Minneapolis KS 67467",
  ].join("\r\n");
  const raw = [
    'Content-Type: multipart/mixed; boundary="Apple-Mail-1"',
    "",
    "--Apple-Mail-1",
    "Content-Type: text/plain; charset=us-ascii",
    "Content-Transfer-Encoding: 7bit",
    "",
    full,
    "--Apple-Mail-1",
    "Content-Type: text/plain; charset=us-ascii",
    "Content-Transfer-Encoding: 7bit",
    "",
    "Sent from my iPhone",
    "--Apple-Mail-1",
    "Content-Type: image/png; name=\"image0.png\"",
    "Content-Disposition: inline; filename=image0.png",
    "Content-Transfer-Encoding: 7bit",
    "",
    "fake-png-bytes",
    "--Apple-Mail-1--",
  ].join("\r\n");

  const parsed = parseFullMime(raw);
  assertStringIncludes(parsed.bodyText, "We placed (2) separate orders");
  assertStringIncludes(parsed.bodyText, "Jesse Harris");
  assertEquals(parsed.bodyText.trim() === "Sent from my iPhone", false);
});

Deno.test("parseFullMime keeps single-part body that ends with iPhone signature", () => {
  const raw = [
    'Content-Type: multipart/mixed; boundary="Apple-Mail-2"',
    "",
    "--Apple-Mail-2",
    "Content-Type: text/plain; charset=us-ascii",
    "",
    "Hello,\r\n\r\nPlease check our second order.\r\nSent from my iPhone",
    "--Apple-Mail-2",
    "Content-Type: image/png; name=\"image0.png\"",
    "Content-Disposition: inline; filename=image0.png",
    "Content-Transfer-Encoding: 7bit",
    "",
    "fake-png-bytes",
    "--Apple-Mail-2--",
  ].join("\r\n");

  const parsed = parseFullMime(raw);
  assertStringIncludes(parsed.bodyText, "Please check our second order");
  assertStringIncludes(parsed.bodyText, "Sent from my iPhone");
});

Deno.test("hasReadableEmailBody treats mobile signature only as missing", () => {
  assertEquals(hasReadableEmailBody("Sent from my iPhone", null), false);
  assertEquals(hasReadableEmailBody("  Sent from my iPhone  ", null), false);
  assertEquals(
    hasReadableEmailBody("Hello,\n\nPlease check order.\nSent from my iPhone", null),
    true,
  );
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

Deno.test("parseFullMime prefers Gmail reply plain over longer quote-only sibling part", () => {
  const replyPlain = [
    "Hello,",
    "",
    "There's a default with the night stand dresser it won't fully go inside",
    "",
    "On Jul 7, 2026, at 3:25 PM, HAUOMS <store+71211516146@t.shopifyemail.com> wrote:",
    "> ORDER HAUOMS2887",
    "> Your order is on the way",
  ].join("\r\n");
  const embeddedOriginal = [
    "ORDER HAUOMS2887",
    "",
    "Your order is on the way to you. Here are the tracking numbers:",
    "FedEx tracking number: 874029148526",
    "FedEx tracking number: 874029149853",
    "Items in this shipment:",
    "Modern 5 Drawer Fabric Dresser Night Stand x 2",
    "x".repeat(800),
  ].join("\r\n");

  const raw = [
    'Content-Type: multipart/mixed; boundary="mix1"',
    "",
    "--mix1",
    'Content-Type: multipart/alternative; boundary="alt1"',
    "",
    "--alt1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    replyPlain,
    "--alt1",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<div dir="ltr">Hello,<div>There\'s a default with the night stand dresser it won\'t fully go inside</div></div>',
    "--alt1--",
    "--mix1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    embeddedOriginal,
    "--mix1",
    "Content-Type: image/jpeg; name=\"photo.jpg\"",
    "Content-Disposition: attachment; filename=photo.jpg",
    "",
    "fake-jpeg",
    "--mix1--",
  ].join("\r\n");

  const parsed = parseFullMime(raw);
  assertStringIncludes(parsed.bodyText, "Hello");
  assertStringIncludes(parsed.bodyText, "night stand dresser");
  assertEquals(parsed.bodyText.includes("874029148526") && !parsed.bodyText.includes("Hello"), false);
});

Deno.test("parseFullMime skips message/rfc822 embedded original in mixed", () => {
  const replyPlain = [
    "Hello,",
    "",
    "There's a default with the night stand dresser it won't fully go inside",
    "",
    "2026年7月7日下午3:25, HAUOMS <store+71211516146@t.shopifyemail.com>写道：",
    "> ORDER HAUOMS2887",
  ].join("\r\n");
  const embeddedOriginal = [
    "ORDER HAUOMS2887",
    "FedEx tracking number: 874029148526",
    "y".repeat(900),
  ].join("\r\n");
  const rfc822 = [
    "From: HAUOMS <store+71211516146@t.shopifyemail.com>",
    "Subject: Shipping update for order hauoms2887",
    "Content-Type: text/plain; charset=utf-8",
    "",
    embeddedOriginal,
  ].join("\r\n");

  const raw = [
    'Content-Type: multipart/mixed; boundary="mix2"',
    "",
    "--mix2",
    'Content-Type: multipart/alternative; boundary="alt2"',
    "",
    "--alt2",
    "Content-Type: text/plain; charset=utf-8",
    "",
    replyPlain,
    "--alt2",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Hello,</p><p>There's a default with the night stand dresser it won't fully go inside</p>",
    "--alt2--",
    "--mix2",
    "Content-Type: message/rfc822",
    "",
    rfc822,
    "--mix2--",
  ].join("\r\n");

  const parsed = parseFullMime(raw);
  assertStringIncludes(parsed.bodyText, "night stand dresser");
  assertStringIncludes(parsed.bodyText, "Hello");
});

Deno.test("parseFullMime prefers plain with new reply when html is quote-only Shopify template", () => {
  const replyPlain = [
    "Hello,",
    "",
    "There's a default with the night stand dresser it won't fully go inside",
    "",
    "On Jul 7, 2026, at 3:25 PM, HAUOMS wrote:",
    "> ORDER HAUOMS2887",
  ].join("\r\n");
  const shopifyHtml =
    "<html><body><h1>HAUOMS</h1><p>ORDER HAUOMS2887</p><p>FedEx tracking number: 874029148526</p></body></html>";

  const raw = [
    'Content-Type: multipart/alternative; boundary="alt3"',
    "",
    "--alt3",
    "Content-Type: text/plain; charset=utf-8",
    "",
    replyPlain,
    "--alt3",
    "Content-Type: text/html; charset=utf-8",
    "",
    shopifyHtml,
    "--alt3--",
  ].join("\r\n");

  const parsed = parseFullMime(raw);
  assertStringIncludes(parsed.bodyText, "night stand dresser");
  assertEquals(parsed.bodyHtml, null);
});
