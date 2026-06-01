import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { hostNeedsCustomMailCa, isUnknownIssuerTlsError } from "./mail-tls-ca.ts";

Deno.test("hostNeedsCustomMailCa: 163 and enterprise mail", () => {
  assertEquals(hostNeedsCustomMailCa("imap.163.com"), true);
  assertEquals(hostNeedsCustomMailCa("imap.qiye.163.com"), true);
  assertEquals(hostNeedsCustomMailCa("imap.exmail.qq.com"), true);
});

Deno.test("hostNeedsCustomMailCa: public providers", () => {
  assertEquals(hostNeedsCustomMailCa("imap.gmail.com"), false);
  assertEquals(hostNeedsCustomMailCa("outlook.office365.com"), false);
});

Deno.test("isUnknownIssuerTlsError: Deno InvalidData with empty message", () => {
  const err = new Error("");
  err.name = "InvalidData";
  Object.assign(err, { message: "" });
  assertEquals(isUnknownIssuerTlsError(err), false);
  assertEquals(
    isUnknownIssuerTlsError(new Error("invalid peer certificate: UnknownIssuer")),
    true,
  );
  assertEquals(
    isUnknownIssuerTlsError({ name: "InvalidData", message: "invalid peer certificate: UnknownIssuer" }),
    true,
  );
});
