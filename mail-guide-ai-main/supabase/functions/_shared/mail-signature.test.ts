import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { appendMailboxSignature } from "./mail-signature.ts";

Deno.test("appendMailboxSignature disabled leaves body", () => {
  assertEquals(
    appendMailboxSignature("Hello", { signature_enabled: false, signature_text: "Sig" }),
    "Hello",
  );
});

Deno.test("appendMailboxSignature appends when enabled", () => {
  assertEquals(
    appendMailboxSignature("Hello", { signature_enabled: true, signature_text: "Team" }),
    "Hello\n\nTeam",
  );
});

Deno.test("appendMailboxSignature empty sig unchanged", () => {
  assertEquals(
    appendMailboxSignature("Hello", { signature_enabled: true, signature_text: "  " }),
    "Hello",
  );
});
