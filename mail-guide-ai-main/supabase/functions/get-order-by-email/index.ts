// 通过订单号 + 邮箱查询 ERP 订单 Edge Function（供 Dify 工作流调用）
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 鉴权：支持 service_role key 或已登录用户
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const isServiceRole = token && token === SUPABASE_SERVICE_ROLE_KEY;

    if (!isServiceRole) {
      if (!token) {
        return new Response(JSON.stringify({ error: "未授权" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
      const { data: userData } = await userClient.auth.getUser();
      if (!userData?.user) {
        return new Response(JSON.stringify({ error: "未登录" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const url = new URL(req.url);
    const orderNo = url.searchParams.get("order_no");
    const email = url.searchParams.get("email");

    if (!orderNo) {
      return new Response(JSON.stringify({ error: "缺少 order_no 参数" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 查找订单（优先匹配 order_no + customer_email，其次仅匹配 order_no）
    let query = admin
      .from("orders")
      .select("*")
      .eq("order_no", orderNo);

    if (email) {
      query = query.eq("customer_email", email);
    }

    let { data: order, error: orderErr } = await query.maybeSingle();

    // 如果精确匹配没找到，用 order_no 单独查（取第一条）
    if (!order && email) {
      const { data: fallback } = await admin
        .from("orders")
        .select("*")
        .eq("order_no", orderNo)
        .limit(1);
      if (fallback && fallback.length > 0) order = fallback[0];
    }

    if (orderErr || !order) {
      return new Response(
        JSON.stringify({
          found: false,
          order: null,
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 尝试从 raw_data 中提取 tracking_url
    let trackingUrl = order.tracking_no ?? "";
    if (order.raw_data) {
      try {
        const raw = typeof order.raw_data === "string" ? JSON.parse(order.raw_data) : order.raw_data;
        if (raw.tracking_url) trackingUrl = raw.tracking_url;
        else if (raw.tracking_urls?.[0]) trackingUrl = raw.tracking_urls[0];
      } catch { /* ignore */ }
    }

    return new Response(
      JSON.stringify({
        found: true,
        order: {
          order_no: order.order_no,
          customer_name: order.customer_name ?? "",
          product_name: order.product_summary ?? "",
          status: order.order_status ?? "",
          currency: order.currency ?? "USD",
          amount: order.amount ?? 0,
          placed_at: order.ordered_at ?? order.created_at,
          tracking_url: trackingUrl,
          shipping_status: order.shipping_status ?? "",
          tracking_no: order.tracking_no ?? "",
        },
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (e) {
    console.error("get-order-by-email error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "未知错误" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
