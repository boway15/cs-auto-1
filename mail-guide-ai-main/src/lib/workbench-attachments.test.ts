import { describe, expect, it } from "vitest";
import {
  displayAttachmentFilename,
  isLikelyInlineImageAttachment,
  isPlaceholderAttachment,
  partitionWorkbenchAttachments,
} from "./workbench-attachments";

describe("workbench-attachments", () => {
  it("识别占位附件", () => {
    expect(
      isPlaceholderAttachment({
        count: 1,
        note: "历史邮件轻量同步已检测到附件",
      }),
    ).toBe(true);
    expect(
      isPlaceholderAttachment({
        filename: "a.pdf",
        storage_path: "mb/eid/0_a.pdf",
      }),
    ).toBe(false);
  });

  it("为无扩展名附件按 MIME 补扩展名", () => {
    expect(
      displayAttachmentFilename({
        filename: "attachment-1",
        contentType: "application/pdf",
      }),
    ).toBe("attachment-1.pdf");
  });

  it("Outlook image00N 归入正文内嵌图", () => {
    const email = {
      body_text: "Amazon, sorry for the delay",
      body_html:
        '<html xmlns:v="urn:schemas-microsoft-com:vml"><body><p class=MsoNormal>&nbsp;</p></body></html>',
    };
    const img = { filename: "image002.jpg", contentType: "image/jpeg", storage_path: "x/y.jpg" };
    expect(isLikelyInlineImageAttachment(img, email)).toBe(true);
    const { inlineImages, fileAttachments } = partitionWorkbenchAttachments([img], email);
    expect(inlineImages).toHaveLength(1);
    expect(fileAttachments).toHaveLength(0);
  });

  it("PDF 仍列为附件", () => {
    const pdf = { filename: "invoice.pdf", contentType: "application/pdf", storage_path: "x/a.pdf" };
    const { fileAttachments } = partitionWorkbenchAttachments([pdf], { body_text: "hi" });
    expect(fileAttachments).toHaveLength(1);
  });
});
