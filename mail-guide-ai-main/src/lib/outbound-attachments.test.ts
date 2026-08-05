import { describe, expect, it } from "vitest";
import {
  buildOutboundStoragePath,
  isOutboundImageAttachment,
  parseSendLogOutboundAttachments,
  sanitizeOutboundFilename,
  sanitizeOutboundStorageKeySegment,
  validateOutboundFile,
  OUTBOUND_MAX_FILE_BYTES,
  OUTBOUND_MAX_TOTAL_BYTES,
} from "./outbound-attachments";

describe("outbound-attachments", () => {
  it("sanitizeOutboundFilename 去除路径字符", () => {
    expect(sanitizeOutboundFilename("../evil.pdf")).toBe("evil.pdf");
    expect(sanitizeOutboundFilename("发票 001.pdf")).toBe("发票 001.pdf");
  });

  it("sanitizeOutboundStorageKeySegment 中文文件名转为 ASCII key", () => {
    expect(sanitizeOutboundStorageKeySegment("做柜小助手.pdf")).toBe("file.pdf");
    expect(sanitizeOutboundStorageKeySegment("invoice 001.pdf")).toBe("invoice_001.pdf");
  });

  it("buildOutboundStoragePath 不含非 ASCII 字符", () => {
    const path = buildOutboundStoragePath(
      "user-id",
      "session-id",
      { name: "做柜小助手.pdf" } as File,
    );
    expect(path).toMatch(/^user-id\/session-id\/[0-9a-f-]+_file\.pdf$/);
    expect(/[^\x00-\x7F]/.test(path)).toBe(false);
  });

  it("validateOutboundFile 拒绝超大文件", () => {
    const r = validateOutboundFile(
      { name: "big.pdf", type: "application/pdf", size: OUTBOUND_MAX_FILE_BYTES + 1 },
      0,
    );
    expect(r.ok).toBe(false);
  });

  it("validateOutboundFile 拒绝总大小超限", () => {
    const r = validateOutboundFile(
      { name: "a.pdf", type: "application/pdf", size: 5_000_000 },
      OUTBOUND_MAX_TOTAL_BYTES - 1_000_000,
    );
    expect(r.ok).toBe(false);
  });

  it("validateOutboundFile 接受合法 PDF", () => {
    const r = validateOutboundFile(
      { name: "a.pdf", type: "application/pdf", size: 1000 },
      0,
    );
    expect(r.ok).toBe(true);
  });

  it("parseSendLogOutboundAttachments 解析 metadata", () => {
    expect(parseSendLogOutboundAttachments(null)).toEqual([]);
    expect(
      parseSendLogOutboundAttachments({
        attachments: [
          {
            filename: "a.png",
            content_type: "image/png",
            storage_path: "sent/mb/log/a.png",
          },
          { filename: "", storage_path: "x" },
        ],
      }),
    ).toEqual([
      {
        filename: "a.png",
        content_type: "image/png",
        storage_path: "sent/mb/log/a.png",
      },
    ]);
  });

  it("isOutboundImageAttachment 按 MIME 或扩展名判断", () => {
    expect(isOutboundImageAttachment({ filename: "a.bin", content_type: "image/png" })).toBe(true);
    expect(isOutboundImageAttachment({ filename: "a.JPG", content_type: "application/octet-stream" })).toBe(true);
    expect(isOutboundImageAttachment({ filename: "a.pdf", content_type: "application/pdf" })).toBe(false);
  });
});
