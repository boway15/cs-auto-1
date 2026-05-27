import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateErpSiteMailbox } from "./erp-site-mailbox.ts";

const SITE = {
  id: "s1",
  site_code: "sedeta-us",
  site_name: "SEDETA US",
  sender_email: "notify@example.com",
  is_active: true,
};

const MB = {
  id: "m1",
  email_address: "notify@example.com",
  smtp_host: "smtp.example.com",
  smtp_port: 465,
  is_active: true,
};

Deno.test("evaluateErpSiteMailbox success", () => {
  const r = evaluateErpSiteMailbox(SITE, MB);
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.site.site_code, "sedeta-us");
    assertEquals(r.mailbox.email_address, "notify@example.com");
  }
});

Deno.test("evaluateErpSiteMailbox missing site", () => {
  const r = evaluateErpSiteMailbox(null, MB);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "SITE_NOT_CONFIGURED");
});

Deno.test("evaluateErpSiteMailbox inactive site", () => {
  const r = evaluateErpSiteMailbox({ ...SITE, is_active: false }, MB);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "SITE_NOT_CONFIGURED");
});

Deno.test("evaluateErpSiteMailbox empty sender", () => {
  const r = evaluateErpSiteMailbox({ ...SITE, sender_email: "" }, MB);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "SENDER_NOT_CONFIGURED");
});

Deno.test("evaluateErpSiteMailbox missing mailbox", () => {
  const r = evaluateErpSiteMailbox(SITE, null);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "MAILBOX_SMTP_MISSING");
});

Deno.test("evaluateErpSiteMailbox missing smtp", () => {
  const r = evaluateErpSiteMailbox(SITE, { ...MB, smtp_host: null });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "MAILBOX_SMTP_MISSING");
});
