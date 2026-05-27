import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  parseErpNotifyItemCount,
  renderErpNotifyTemplate,
} from "./erp-template-render.ts";

const VALUES = {
  order_no: "SO1",
  item_count: 4,
  site_code: "sedeta-us",
  site_name: "SEDETA US Store",
};

Deno.test("renderErpNotifyTemplate replaces order_no", () => {
  assertEquals(
    renderErpNotifyTemplate("Order {{order_no}} end", VALUES),
    "Order SO1 end",
  );
});

Deno.test("renderErpNotifyTemplate replaces item_count", () => {
  assertEquals(
    renderErpNotifyTemplate("Qty {{item_count}}", VALUES),
    "Qty 4",
  );
});

Deno.test("renderErpNotifyTemplate replaces site_code and site_name", () => {
  assertEquals(
    renderErpNotifyTemplate("{{site_code}} / {{site_name}}", VALUES),
    "sedeta-us / SEDETA US Store",
  );
});

Deno.test("renderErpNotifyTemplate unknown key empty", () => {
  assertEquals(
    renderErpNotifyTemplate("{{foo}}", VALUES),
    "",
  );
});

Deno.test("parseErpNotifyItemCount accepts number and string", () => {
  assertEquals(parseErpNotifyItemCount(4), 4);
  assertEquals(parseErpNotifyItemCount("4"), 4);
});

Deno.test("parseErpNotifyItemCount rejects invalid", () => {
  assertEquals(parseErpNotifyItemCount(null), null);
  assertEquals(parseErpNotifyItemCount(0), null);
  assertEquals(parseErpNotifyItemCount(1.5), null);
  assertEquals(parseErpNotifyItemCount("abc"), null);
});
