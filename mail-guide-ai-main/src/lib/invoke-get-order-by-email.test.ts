import { describe, expect, it } from "vitest";
import { buildGetOrderByEmailUrl } from "./invoke-get-order-by-email";

describe("buildGetOrderByEmailUrl", () => {
  it("includes email_id when provided", () => {
    const url = buildGetOrderByEmailUrl("https://example.supabase.co/", "ORD-1", "buyer@example.com", {
      emailId: "email-uuid-1",
    });
    expect(url).toContain("email_id=email-uuid-1");
    expect(url).toContain("order_no=ORD-1");
    expect(url).toContain("email=buyer");
  });

  it("adds refresh flag", () => {
    const url = buildGetOrderByEmailUrl("https://x.co", "O1", "", { refresh: true });
    expect(url).toContain("refresh=1");
  });
});
