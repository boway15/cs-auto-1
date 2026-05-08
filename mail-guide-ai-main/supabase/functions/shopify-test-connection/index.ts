// 测试 Shopify Admin API 连接是否有效
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { shop_domain, access_token, api_version = "2024-10" } = await req.json();

    if (!shop_domain || !access_token) {
      return new Response(
        JSON.stringify({ ok: false, message: "缺少 shop_domain 或 access_token" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 规范化域名
    const domain = String(shop_domain).trim().replace(/^https?:\/\//, "").replace(/\/$/, "");

    const url = `https://${domain}/admin/api/${api_version}/shop.json`;
    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": access_token,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      return new Response(
        JSON.stringify({
          ok: false,
          message: `HTTP ${res.status}: ${text.slice(0, 300)}`,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const data = await res.json();
    return new Response(
      JSON.stringify({
        ok: true,
        message: `连接成功 ✅ 店铺：${data.shop?.name ?? domain}`,
        shop: {
          name: data.shop?.name,
          email: data.shop?.email,
          currency: data.shop?.currency,
          timezone: data.shop?.iana_timezone,
          plan: data.shop?.plan_display_name,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, message: e instanceof Error ? e.message : String(e) }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
