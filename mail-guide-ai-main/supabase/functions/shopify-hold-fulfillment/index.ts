// 标记/解除订单暂停发货：本地标记 + 回写 Shopify tag
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const HOLD_TAG = "hold-shipping";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // 验证用户身份
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "未授权" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "未授权" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { order_id, action, reason, reason_category, email_id } = body as {
      order_id: string;
      action: "hold" | "release";
      reason?: string;
      reason_category?: string;
      email_id?: string;
    };

    if (!order_id || !["hold", "release"].includes(action)) {
      return new Response(JSON.stringify({ error: "参数错误" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(supabaseUrl, serviceKey);

    // 取订单
    const { data: order, error: orderErr } = await admin
      .from("orders")
      .select("id, shop_id, shopify_order_id, shopify_tags")
      .eq("id", order_id)
      .single();
    if (orderErr || !order) throw new Error("订单不存在");

    // 1. 更新本地
    const updates: any = action === "hold"
      ? {
          shipping_hold: true,
          hold_reason: reason ?? null,
          hold_at: new Date().toISOString(),
          hold_by: user.id,
        }
      : {
          shipping_hold: false,
          hold_reason: null,
          hold_at: null,
          hold_by: null,
        };
    await admin.from("orders").update(updates).eq("id", order_id);

    // 2. 回写 Shopify tag
    let shopifySynced = false;
    let shopifyError: string | null = null;

    if (order.shop_id && order.shopify_order_id) {
      const { data: shop } = await admin
        .from("shopify_shops")
        .select("shop_domain, access_token, api_version")
        .eq("id", order.shop_id)
        .single();

      if (shop) {
        try {
          const currentTags = (order.shopify_tags ?? "").split(",").map((t: string) => t.trim()).filter(Boolean);
          let newTags: string[];
          if (action === "hold") {
            newTags = currentTags.includes(HOLD_TAG) ? currentTags : [...currentTags, HOLD_TAG];
          } else {
            newTags = currentTags.filter((t: string) => t !== HOLD_TAG);
          }
          const noteAttr = action === "hold" && reason
            ? { note: `[暂停发货] ${reason_category ?? ""} ${reason}`.trim() }
            : {};

          const url = `https://${shop.shop_domain}/admin/api/${shop.api_version}/orders/${order.shopify_order_id}.json`;
          const res = await fetch(url, {
            method: "PUT",
            headers: {
              "X-Shopify-Access-Token": shop.access_token,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              order: {
                id: Number(order.shopify_order_id),
                tags: newTags.join(", "),
                ...noteAttr,
              },
            }),
          });
          if (!res.ok) {
            const t = await res.text();
            throw new Error(`Shopify ${res.status}: ${t.slice(0, 200)}`);
          }
          shopifySynced = true;
          await admin.from("orders").update({ shopify_tags: newTags.join(", ") }).eq("id", order_id);
        } catch (e) {
          shopifyError = e instanceof Error ? e.message : String(e);
        }
      }
    }

    // 3. 写日志
    await admin.from("order_hold_logs").insert({
      order_id,
      email_id: email_id ?? null,
      action,
      reason: reason ?? null,
      reason_category: reason_category ?? null,
      shopify_synced: shopifySynced,
      shopify_sync_error: shopifyError,
      performed_by: user.id,
    });

    return new Response(
      JSON.stringify({
        ok: true,
        shopify_synced: shopifySynced,
        shopify_error: shopifyError,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
