import { describe, expect, it } from "vitest";
import { createSendIdempotencyKey, extractOrderNo, getMissingElements } from "./customerServiceGuards";

describe("customer service guard utilities", () => {
  it("extracts explicit order numbers from customer text", () => {
    expect(extractOrderNo("Please cancel order SO20260428001")).toBe("SO20260428001");
    expect(extractOrderNo("订单：AB-123456 need address change")).toBe("AB-123456");
  });

  it("requires order number and image for damaged item claims", () => {
    expect(getMissingElements({
      subject: "Broken item",
      body_text: "The product arrived damaged, please refund",
      has_attachment: false,
    })).toEqual(["order_no", "image"]);
  });

  it("does not require image when an attachment is already present", () => {
    expect(getMissingElements({
      subject: "Broken item for order SO20260428001",
      body_text: "Photo attached",
      has_attachment: true,
    })).toEqual([]);
  });

  it("creates stable idempotency keys for the same reply body", async () => {
    await expect(createSendIdempotencyKey("email-1", "user-1", "hello")).resolves.toBe(
      await createSendIdempotencyKey("email-1", "user-1", "hello")
    );
    await expect(createSendIdempotencyKey("email-1", "user-1", "hello2")).resolves.not.toBe(
      await createSendIdempotencyKey("email-1", "user-1", "hello")
    );
  });
});
