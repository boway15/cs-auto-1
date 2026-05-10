/**
 * 将 OMS QueryOrderInfo 返回的 data 内层对象映射并写入本地 orders（erp_config_id 为空）。
 */

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

/** 多键名取第一个非空字符串（兼容 OMS .NET PascalCase 与 camelCase/snake_case）。 */
function pickStr(inner: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const s = str(inner[k]);
    if (s) return s;
  }
  return null;
}

/**
 * 从内层 data / 列表行得到订单号。
 * 须覆盖 PascalCase（如 OrderNo、EbayOrderId），否则 OMS 有单但 upsert 会拿不到 order_no。
 */
export function orderNoFromOmsInner(inner: Record<string, unknown>): string | null {
  return pickStr(inner, [
    "orderId",
    "orderNo",
    "order_no",
    "OrderId",
    "OrderNo",
    "ebayOrderId",
    "EbayOrderId",
    "ebay_order_id",
    "platformOrderId",
    "PlatformOrderId",
    "amazonOrderId",
    "AmazonOrderId",
  ]);
}

export async function upsertOrderFromOmsData(
  admin: any,
  inner: Record<string, unknown>,
  contextEmail: string,
): Promise<{ id: string; order_no: string } | null> {
  const orderNo = orderNoFromOmsInner(inner);
  if (!orderNo) return null;

  const customerEmail =
    pickStr(inner, ["customerEmail", "customer_email", "email", "CustomerEmail", "Email", "buyerEmail", "BuyerEmail"]) ??
    (contextEmail.trim() || null);
  const customerName = pickStr(inner, [
    "customerName",
    "customer_name",
    "buyerName",
    "BuyerName",
    "CustomerName",
  ]);
  const productSummary = pickStr(inner, [
    "productName",
    "product_summary",
    "productSummary",
    "ProductName",
    "ProductSummary",
  ]);
  const orderStatus = pickStr(inner, ["orderStatus", "order_status", "status", "OrderStatus", "Status"]);
  const shippingStatus = pickStr(inner, ["shippingStatus", "shipping_status", "ShippingStatus"]);
  const trackingNo = pickStr(inner, ["trackingNo", "tracking_no", "TrackingNo"]);
  const currency = pickStr(inner, ["currency", "Currency"]) ?? "USD";
  const amountRaw =
    inner.amount ??
    inner.totalAmount ??
    inner.total_amount ??
    inner.TotalAmount ??
    inner.Amount;
  const amount = typeof amountRaw === "number" ? amountRaw : (amountRaw != null ? Number(amountRaw) : null);
  const orderedAtRaw = inner.ordered_at ?? inner.orderedAt ?? inner.OrderedAt;
  const orderedAt = orderedAtRaw != null && String(orderedAtRaw).trim() !== ""
    ? String(orderedAtRaw).trim()
    : null;

  const row: Record<string, unknown> = {
    order_no: orderNo,
    customer_email: customerEmail,
    customer_name: customerName,
    product_summary: productSummary,
    order_status: orderStatus,
    shipping_status: shippingStatus,
    tracking_no: trackingNo,
    currency,
    amount: Number.isFinite(amount as number) ? amount : null,
    ordered_at: orderedAt,
    raw_data: inner,
    erp_config_id: null,
    updated_at: new Date().toISOString(),
  };

  const { data: existingRows } = await admin.from("orders").select("id").eq("order_no", orderNo).limit(1);
  const existing = existingRows?.[0];
  if (existing?.id) {
    const { error } = await admin.from("orders").update(row).eq("id", existing.id);
    if (error) throw error;
    return { id: existing.id, order_no: orderNo };
  }

  const { data: ins, error } = await admin.from("orders").insert(row).select("id").single();
  if (error) throw error;
  if (!ins?.id) return null;
  return { id: ins.id as string, order_no: orderNo };
}
