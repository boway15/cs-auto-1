import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseAttachmentPartSections } from "./imap-bodystructure.ts";

Deno.test("parseAttachmentPartSections finds attachment parts", () => {
  const raw = [
    "* 1 FETCH (BODYSTRUCTURE (",
    "(\"TEXT\" \"PLAIN\" (\"CHARSET\" \"UTF-8\") NIL NIL \"7BIT\" 120 2)",
    "(\"APPLICATION\" \"PDF\" (\"NAME\" \"report.pdf\") NIL NIL \"BASE64\" 4096 2)",
    " \"ATTACHMENT\" (\"FILENAME\" \"report.pdf\")) \"MIXED\" (\"BOUNDARY\" \"b\") NIL NIL)",
    " RFC822.SIZE 5000)",
  ].join(" ");

  const parts = parseAttachmentPartSections(raw);
  assertEquals(parts.length >= 1, true);
  const pdf = parts.find((p) => p.contentType.includes("pdf"));
  assertEquals(pdf?.section, "2");
  assertEquals(pdf?.filename, "report.pdf");
});
