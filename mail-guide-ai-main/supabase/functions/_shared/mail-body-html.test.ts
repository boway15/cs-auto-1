import { assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  linkifyPlainTextFragment,
  plainTextToHtmlEmail,
} from "./mail-body-html.ts";

Deno.test("linkifyPlainTextFragment mailto and https", () => {
  const html = linkifyPlainTextFragment("service@sedetalife.com");
  assertMatch(html, /<a href="mailto:service@sedetalife\.com">/);
  const url = linkifyPlainTextFragment("https://sedetalife.com");
  assertMatch(url, /<a href="https:\/\/sedetalife\.com">https:\/\/sedetalife\.com<\/a>/);
});

Deno.test("plainTextToHtmlEmail signature block", () => {
  const sig = [
    "Customer Service",
    "service@sedetalife.com",
    "https://sedetalife.com",
  ].join("\n");
  const html = plainTextToHtmlEmail(sig);
  assertMatch(html, /mailto:service@sedetalife\.com/);
  assertMatch(html, /href="https:\/\/sedetalife\.com"/);
  assertEquals((html.match(/<br>/g) ?? []).length, 2);
});

Deno.test("linkifyPlainTextFragment escapes script", () => {
  const html = linkifyPlainTextFragment("<script>alert(1)</script>");
  assertEquals(html.includes("<script>"), false);
  assertEquals(html.includes("&lt;script&gt;"), true);
});
