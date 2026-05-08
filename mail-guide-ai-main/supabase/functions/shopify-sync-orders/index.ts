// Shopify 订单同步：增量拉取 + 写入 orders 表
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PAGE_SIZE = 100;
const TIME_BUDGET_MS = 25_000;
const MAX_PAGES_PER_SHOP = 5; // 每次最多拉 500 单，剩余下次再拉

interface ShopifyOrder {
  id: number;
  admin_graphql_api_id: string;
  name: string;
  email: string | null;
  created_at: string;
  updated_at: string;
  total_price: string;
  currency: string;
  financial_status: string | null;
  fulfillment_status: string | null;
  tags: string;
  customer: { first_name?: string; last_name?: string; email?: string } | null;
  shipping_address: any;
  line_items: { title: string; quantity: number; sku?: string }[];
  fulfillments?: { tracking_number?: string; tracking_company?: string }[];
}

async function syncOneShop(supabase: any, shop: any, startedAt: number) {
  const startCursor = shop.last_sync_cursor
    ? new Date(shop.last_sync_cursor).toISOString()
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 默认30天

  let totalInserted = 0;
  let totalUpdated = 0;
  let pageInfo: string | null = null;
  let pages = 0;
  let latestUpdatedAt = startCursor;

  while (pages < MAX_PAGES_PER_SHOP) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;
    pages++;

    const baseUrl = `https://${shop.shop_domain}/admin/api/${shop.api_version}/orders.json`;
    const url = pageInfo
      ? `${baseUrl}?limit=${PAGE_SIZE}&page_info=${pageInfo}`
      : `${baseUrl}?limit=${PAGE_SIZE}&status=any&updated_at_min=${encodeURIComponent(startCursor)}&order=updated_at+asc`;

    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": shop.access_token,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify API ${res.status}: ${text.slice(0, 200)}`);
    }

    const { orders }: { orders: ShopifyOrder[] } = await res.json();
    if (!orders || orders.length === 0) {
      pageInfo = null;
      break;
    }

    for (const o of orders) {
      const customerName =
        o.customer ? [o.customer.first_name, o.customer.last_name].filter(Boolean).join(" ").trim() || null : null;
      const productSummary = (o.line_items ?? [])
        .map((li) => `${li.title}${li.quantity > 1 ? ` ×${li.quantity}` : ""}`)
        .join("; ")
        .slice(0, 500);
      const trackingNo = o.fulfillments?.[0]?.tracking_number ?? null;

      const row = {
        shop_id: shop.id,
        shopify_order_id: String(o.id),
        shopify_order_gid: o.admin_graphql_api_id,
        order_no: o.name,
        customer_email: o.email ?? o.customer?.email ?? null,
        customer_name: customerName,
        amount: parseFloat(o.total_price) || null,
        currency: o.currency,
        order_status: o.financial_status,
        financial_status: o.financial_status,
        fulfillment_status: o.fulfillment_status,
        shipping_status: o.fulfillment_status,
        tracking_no: trackingNo,
        product_summary: productSummary,
        ordered_at: o.created_at,
        shipping_address: o.shipping_address ?? null,
        shopify_tags: o.tags ?? null,
        raw_data: o as any,
      };

      // upsert by (shop_id, shopify_order_id)
      const { data: existing } = await supabase
        .from("orders")
        .select("id, shipping_hold")
        .eq("shop_id", shop.id)
        .eq("shopify_order_id", String(o.id))
        .maybeSingle();

      if (existing) {
        await supabase.from("orders").update(row).eq("id", existing.id);
        totalUpdated++;
      } else {
        await supabase.from("orders").insert(row);
        totalInserted++;
      }

      if (o.updated_at > latestUpdatedAt) latestUpdatedAt = o.updated_at;
    }

    // Shopify 用 Link header 做分页
    const link = res.headers.get("link") || res.headers.get("Link");
    const next = link?.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    if (next) {
      pageInfo = next[1];
    } else {
      pageInfo = null;
      break;
    }
  }

  // 更新游标（最后一条 updated_at + 1ms 防重复）
  const nextCursor = new Date(new Date(latestUpdatedAt).getTime() + 1).toISOString();
  await supabase
    .from("shopify_shops")
    .update({
      last_synced_at: new Date().toISOString(),
      last_sync_cursor: nextCursor,
      last_error: null,
    })
    .eq("id", shop.id);

  return { inserted: totalInserted, updated: totalUpdated, pages, has_more: !!pageInfo };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(supabaseUrl, serviceKey);
  const startedAt = Date.now();

  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const shopId: string | undefined = body.shop_id;

    let query = supabase.from("shopify_shops").select("*").eq("is_active", true);
    if (shopId) query = query.eq("id", shopId);
    const { data: shops, error: shopsErr } = await query;
    if (shopsErr) throw shopsErr;

    const results: any[] = [];
    for (const shop of shops ?? []) {
      try {
        const r = await syncOneShop(supabase, shop, startedAt);
        results.push({ shop_id: shop.id, shop_domain: shop.shop_domain, ok: true, ...r });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await supabase.from("shopify_shops").update({ last_error: msg }).eq("id", shop.id);
        results.push({ shop_id: shop.id, shop_domain: shop.shop_domain, ok: false, error: msg });
      }
      if (Date.now() - startedAt > TIME_BUDGET_MS) break;
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
