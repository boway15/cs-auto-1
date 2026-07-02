import { describe, expect, it } from "vitest";
import {
  sanitizeOutboundFilename,
  validateOutboundFile,
  OUTBOUND_MAX_FILE_BYTES,
  OUTBOUND_MAX_TOTAL_BYTES,
} from "./outbound-attachments";

describe("outbound-attachments", () => {
  it("sanitizeOutboundFilename 去除路径字符", () => {
    expect(sanitizeOutboundFilename("../evil.pdf")).toBe("evil.pdf");
    expect(sanitizeOutboundFilename("发票 001.pdf")).toBe("发票 001.pdf");
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
      OUTBOUND_MAX_TOTAL_BYTES,
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
});
