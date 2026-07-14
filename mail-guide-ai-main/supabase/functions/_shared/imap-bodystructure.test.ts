import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { countUserAttachments, parseAttachmentPartSections } from "./imap-bodystructure.ts";

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
  assertEquals(pdf?.kind, "user");
});

Deno.test("countUserAttachments ignores inline images, counts attachment disposition", () => {
  // multipart/MIXED(
  //   multipart/RELATED( text/html, image/png inline logo ),
  //   image/jpeg attachment,
  //   image/jpeg attachment
  // )
  const raw = [
    `* 1 FETCH (BODYSTRUCTURE (`,
    ` (("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 500 10 NIL NIL NIL NIL)`,
    `  ("IMAGE" "PNG" ("NAME" "logo.png") "<logo@cid>" NIL "BASE64" 2000 NIL ("INLINE" ("FILENAME" "logo.png")) NIL NIL)`,
    `  "RELATED" ("BOUNDARY" "rel") NIL NIL)`,
    ` ("IMAGE" "JPEG" ("NAME" "IMG_6406.jpeg") NIL NIL "BASE64" 1300000 NIL ("ATTACHMENT" ("FILENAME" "IMG_6406.jpeg")) NIL NIL)`,
    ` ("IMAGE" "JPEG" ("NAME" "IMG_6407.jpeg") NIL NIL "BASE64" 1400000 NIL ("ATTACHMENT" ("FILENAME" "IMG_6407.jpeg")) NIL NIL)`,
    ` "MIXED" ("BOUNDARY" "mix") NIL NIL) RFC822.SIZE 2800000)`,
  ].join("");

  const userCount = countUserAttachments(raw);
  assertEquals(userCount, 2);

  const parts = parseAttachmentPartSections(raw);
  const userParts = parts.filter((p) => p.kind === "user");
  const inlineParts = parts.filter((p) => p.kind === "inline");
  assertEquals(userParts.length, 2);
  assertEquals(inlineParts.length >= 1, true);
});

Deno.test("filename without disposition still counts as user attachment", () => {
  const raw = [
    `* 1 FETCH (BODYSTRUCTURE (`,
    `("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 20 1)`,
    `("APPLICATION" "PDF" ("NAME" "a.pdf") NIL NIL "BASE64" 4096)`,
    ` "MIXED" ("BOUNDARY" "b") NIL NIL) RFC822.SIZE 5000)`,
  ].join("");
  assertEquals(countUserAttachments(raw), 1);
});

Deno.test("inline non-image with filename counts as user attachment", () => {
  const raw = [
    `* 1 FETCH (BODYSTRUCTURE (`,
    `("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 20 1)`,
    `("APPLICATION" "PDF" ("NAME" "inline.pdf") NIL NIL "BASE64" 4096 NIL ("INLINE" ("FILENAME" "inline.pdf")) NIL NIL)`,
    ` "MIXED" ("BOUNDARY" "b") NIL NIL) RFC822.SIZE 5000)`,
  ].join("");
  assertEquals(countUserAttachments(raw), 1);
  const parts = parseAttachmentPartSections(raw);
  const pdf = parts.find((p) => p.contentType.includes("pdf"));
  assertEquals(pdf?.kind, "user");
  assertEquals(pdf?.filename, "inline.pdf");
});
