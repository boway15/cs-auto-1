import { describe, expect, it } from "vitest";
import { needsReplyToConfirm, normalizeEmailAddress } from "./reply-to-confirm";

describe("normalizeEmailAddress", () => {
  it("提取尖括号内地址并小写", () => {
    expect(normalizeEmailAddress("Shop <Mailer@Shopify.com>")).toBe("mailer@shopify.com");
  });

  it("纯地址小写", () => {
    expect(normalizeEmailAddress("Alice@Example.com")).toBe("alice@example.com");
  });
});

describe("needsReplyToConfirm", () => {
  it("reply_to 为空不确认", () => {
    expect(
      needsReplyToConfirm({ from_email: "a@x.com", reply_to_email: null }),
    ).toBe(false);
    expect(
      needsReplyToConfirm({ from_email: "a@x.com", reply_to_email: "  " }),
    ).toBe(false);
  });

  it("与 from 相同（忽略大小写）不确认", () => {
    expect(
      needsReplyToConfirm({
        from_email: "Alice@Example.com",
        reply_to_email: "alice@example.com",
      }),
    ).toBe(false);
  });

  it("与 from 不同需确认", () => {
    expect(
      needsReplyToConfirm({
        from_email: "mailer@shopify.com",
        reply_to_email: "customer@example.com",
      }),
    ).toBe(true);
  });

  it("带显示名时按邮箱比较", () => {
    expect(
      needsReplyToConfirm({
        from_email: "Shopify <mailer@shopify.com>",
        reply_to_email: "Customer <customer@example.com>",
      }),
    ).toBe(true);
  });
});
