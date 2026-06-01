import { assertEquals, assertMatch, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {

  getAnalysisText,

  getLatestBodyText,

  splitPlainEmailTopAndQuoted,

} from "./email-quote-strip.ts";



const collapsedWithQuote =

  "Amazon, sorry for the delay, we moved\n\nFrom: SEDETA Service <service@sedetalife.com> Sent: Sunday, May 24, 2026 Subject: RE: defective part Dear customer,Thank you for contacting us.";



/** 与 src/lib/email-body.test.ts `formatPlainTextEmailForDisplay` 用例同源（IMAP 压扁一行） */

const collapsedImapBody =

  "Amazon, sorry for the delay, we moved and I was just able to put this together   From: SEDETA Service <service@sedetalife.com> Sent: Sunday, May 24, 2026 7:57 PMTo: pdballou <pdballou@cox.net>Subject: RE: request to replace defective part Dear customer,Thank you for contacting us.I used your email to search in the order on our official website, but did not find the relevant information of your order. In order to better help you solve the problem, can you tell me which platform you purchased our products and what is your order number?Thank you for your understanding and support. Looking forward to your reply.    	SEDETA Serviceservice@sedetalife.com <mailto:service@sedetalife.com>    Original:*	From：pdballou<pdballou@cox.net> *	Date：2026-05-25 00:01:16*	Subject：RE: request to replace defective part  From: pdballou@cox.net Sent: Thursday, May 21, 2026 5:55 AMTo: service@sedetalife.com Subject: request to replace defective partImportance: High Greetings,  I need some support";



Deno.test("splitPlainEmailTopAndQuoted separates top from From header quote", () => {

  const { top, quoted } = splitPlainEmailTopAndQuoted(collapsedWithQuote);

  assertStringIncludes(top, "sorry for the delay");

  assertEquals(top.includes("Dear customer"), false);

  assertMatch(quoted ?? "", /From:\s*SEDETA Service/i);

});



Deno.test("getLatestBodyText returns top only", () => {

  const latest = getLatestBodyText(collapsedWithQuote);

  assertStringIncludes(latest, "Amazon");

  assertEquals(latest.includes("defective part"), false);

});



Deno.test("getAnalysisText combines subject and top", () => {

  const text = getAnalysisText("RE: help", collapsedWithQuote);

  assertEquals(text.startsWith("RE: help"), true);

  assertStringIncludes(text, "sorry for the delay");

  assertEquals(text.includes("Dear customer"), false);

});



Deno.test("collapsed IMAP body: raw split keeps quote in top (unformatted)", () => {

  const { top, quoted } = splitPlainEmailTopAndQuoted(collapsedImapBody);

  assertStringIncludes(top, "sorry for the delay");

  assertEquals(top.includes("Dear customer"), true);

  assertEquals(quoted, null);

});



Deno.test("collapsed IMAP body: getLatestBodyText strips quote like frontend", () => {

  const latest = getLatestBodyText(collapsedImapBody);

  assertStringIncludes(latest, "sorry for the delay");

  assertEquals(latest.includes("Dear customer"), false);

  assertEquals(latest.includes("Greetings,"), false);

});


