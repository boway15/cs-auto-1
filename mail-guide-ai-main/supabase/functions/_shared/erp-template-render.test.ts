import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { renderErpNotifyTemplate } from "./erp-template-render.ts";

Deno.test("renderErpNotifyTemplate replaces order_no", () => {
  assertEquals(
    renderErpNotifyTemplate("Order {{order_no}} end", { order_no: "SO1" }),
    "Order SO1 end",
  );
});

Deno.test("renderErpNotifyTemplate unknown key empty", () => {
  assertEquals(
    renderErpNotifyTemplate("{{foo}}", { order_no: "SO1" }),
    "",
  );
});
