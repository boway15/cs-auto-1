import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  bodyHasCidImageReferences,
  emailHasAttachmentEvidence,
  emailNeedsMediaBinarySync,
} from "./email-attachment-presence.ts";

Deno.test("bodyHasCidImageReferences detects img cid and bracket forms", () => {
  assertEquals(bodyHasCidImageReferences('<img src="cid:image0.jpeg" alt="image0.jpeg">'), true);
  assertEquals(bodyHasCidImageReferences("See [cid:foo.png]"), true);
  assertEquals(bodyHasCidImageReferences("plain text only"), false);
});

Deno.test("emailNeedsMediaBinarySync when cid body but empty attachments", () => {
  assertEquals(
    emailNeedsMediaBinarySync({
      has_attachment: false,
      attachments: [],
      body_html: '<p>hi</p><img src="cid:image0.jpeg" alt="image0.jpeg">',
      body_text: null,
    }),
    true,
  );
});

Deno.test("emailNeedsMediaBinarySync false when stored binary present", () => {
  assertEquals(
    emailNeedsMediaBinarySync({
      has_attachment: true,
      attachments: [{
        filename: "image0.jpeg",
        contentType: "image/jpeg",
        storage_path: "mb/email/0-image0.jpeg",
      }],
      body_html: '<img src="cid:image0.jpeg">',
      body_text: null,
    }),
    false,
  );
});

Deno.test("emailHasAttachmentEvidence true for stored image even if has_attachment false", () => {
  assertEquals(
    emailHasAttachmentEvidence({
      has_attachment: false,
      attachments: [{
        filename: "image0.jpeg",
        contentType: "image/jpeg",
        storage_path: "mb/email/0-image0.jpeg",
      }],
    }),
    true,
  );
});

Deno.test("emailHasAttachmentEvidence respects has_attachment flag", () => {
  assertEquals(
    emailHasAttachmentEvidence({
      has_attachment: true,
      attachments: [{ note: "pending", count: 2 }],
    }),
    true,
  );
  assertEquals(
    emailHasAttachmentEvidence({
      has_attachment: false,
      attachments: [],
    }),
    false,
  );
});
