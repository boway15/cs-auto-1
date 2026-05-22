// 查询订单：order_no 与 email 二选一（至少其一）。非 admin 必须带 email_id（工作台当前邮件上下文）。
// 默认优先本地 orders；配置 ERP_* 时本地无命中可走 OMS QueryOrderInfo 并回写本地。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  erpEnvelopeNoOrderMessage,
  erpEnvelopeOmsQuerySucceeded,
  isErpOmsConfigured,
  queryOrderInfo,
} from "../_shared/erp-client.ts";
import { upsertOrderFromOmsData } from "../_shared/erp-order-sync.ts";
import {
  assertStaffCanAccessEmail,
  getStaffActor,
  isUserAdmin,
  mailboxAccessCorsJsonHeaders,
} from "../_shared/mailbox-access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, api-key, content-type",
};

function buildOrderResponse(order: Record<string, unknown>) {
  let trackingUrl = String(order.tracking_no ?? "");
  if (order.raw_data) {
    try {
      const raw = typeof order.raw_data === "string"
        ? JSON.parse(order.raw_data as string)
        : order.raw_data as Record<string, unknown>;
      if (raw.tracking_url) trackingUrl = String(raw.tracking_url);
      else if (raw.tracking_urls && Array.isArray(raw.tracking_urls) && raw.tracking_urls[0]) {
        trackingUrl = String(raw.tracking_urls[0]);
      }
    } catch { /* ignore */ }
  }
  return {
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
  };
}

async function runErpQueryOrder(
  admin: ReturnType<typeof createClient>,
  qEmail: string,
  qEbay: string,
): Promise<Response> {
  try {
    const r = await queryOrderInfo(qEmail, qEbay);
    const traceId = r.envelope.traceId ?? null;
    const inner = r.envelope.data;

    if (r.ok && inner && typeof inner === "object" && erpEnvelopeOmsQuerySucceeded(r.envelope)) {
      const up = await upsertOrderFromOmsData(admin, inner as Record<string, unknown>, qEmail);
      if (up) {
        const { data: row } = await admin.from("orders").select("*").eq("id", up.id).maybeSingle();
        if (row) {
          return new Response(
            JSON.stringify({
              found: true,
              source: "erp_oms",
              erp_trace_id: traceId,
              order: buildOrderResponse(row as Record<string, unknown>),
              order_id: up.id,
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }
    }

    if (erpEnvelopeNoOrderMessage(r.envelope)) {
      return new Response(
        JSON.stringify({
          found: false,
          order: null,
          erp_trace_id: traceId,
          erp_message: String(r.envelope.data?.message ?? ""),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        found: false,
        order: null,
        erp_trace_id: traceId,
        erp_http_status: r.httpStatus,
        erp_message: String(r.envelope.data?.message ?? r.rawText?.slice(0, 500) ?? ""),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("get-order-by-email ERP:", e);
    return new Response(
      JSON.stringify({
        found: false,
        order: null,
        erp_error: e instanceof Error ? e.message : String(e),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const actor = await getStaffActor(req, admin, {
      supabaseUrl: SUPABASE_URL,
      anonKey: SUPABASE_ANON_KEY,
      serviceKey: SUPABASE_SERVICE_ROLE_KEY,
    });

    const url = new URL(req.url);
    const orderNo = (url.searchParams.get("order_no") ?? "").trim();
    const email = (url.searchParams.get("email") ?? "").trim();
    const emailId = (url.searchParams.get("email_id") ?? "").trim();
    const refreshRaw = (url.searchParams.get("refresh") ?? "").trim().toLowerCase();
    const refresh = refreshRaw === "1" || refreshRaw === "true" || refreshRaw === "yes";

    if (!orderNo && !email) {
      return new Response(JSON.stringify({ error: "请提供 order_no 或 email 至少填写其一" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!actor.isService) {
      const adminUser = await isUserAdmin(admin, actor.userId);
      if (!adminUser && !emailId) {
        return new Response(JSON.stringify({ error: "缺少 email_id，无法在当前邮件上下文外查询订单" }), {
          status: 403,
          headers: mailboxAccessCorsJsonHeaders,
        });
      }
      if (emailId) {
        await assertStaffCanAccessEmail(admin, actor, emailId);
      }
    }

    if (refresh && !orderNo) {
      return new Response(JSON.stringify({ error: "refresh=1 时需同时提供 order_no" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (refresh && orderNo && isErpOmsConfigured()) {
      return await runErpQueryOrder(admin, email, orderNo);
    }

    let order: Record<string, unknown> | null = null;
    let orderErr: unknown = null;

    if (orderNo && email) {
      const q = await admin
        .from("orders")
        .select("*")
        .ilike("order_no", orderNo)
        .ilike("customer_email", email)
        .maybeSingle();
      order = q.data as Record<string, unknown> | null;
      orderErr = q.error;
      if (!order) {
        const fb = await admin.from("orders").select("*").ilike("order_no", orderNo).limit(1);
        if (fb.data?.[0]) order = fb.data[0] as Record<string, unknown>;
      }
    } else if (orderNo) {
      const q = await admin.from("orders").select("*").ilike("order_no", orderNo).limit(1);
      order = (q.data?.[0] as Record<string, unknown>) ?? null;
      orderErr = q.error;
    } else {
      const q = await admin
        .from("orders")
        .select("*")
        .ilike("customer_email", email)
        .order("updated_at", { ascending: false })
        .limit(1);
      order = (q.data?.[0] as Record<string, unknown>) ?? null;
      orderErr = q.error;
    }

    if (!orderErr && order) {
      const orderId = String(order.id ?? "");
      if (emailId && orderId) {
        await admin.from("email_order_links").upsert({
          email_id: emailId,
          order_id: orderId,
          link_source: "manual",
        }, { onConflict: "email_id,order_id" });
      }
      return new Response(
        JSON.stringify({
          found: true,
          source: "local",
          order: buildOrderResponse(order),
          order_id: order.id,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (isErpOmsConfigured()) {
      const erpRes = await runErpQueryOrder(admin, email, orderNo);
      if (emailId && erpRes.ok) {
        try {
          const body = await erpRes.clone().json();
          if (body.found && body.order_id) {
            await admin.from("email_order_links").upsert({
              email_id: emailId,
              order_id: body.order_id,
              link_source: "manual",
            }, { onConflict: "email_id,order_id" });
          }
        } catch { /* ignore */ }
      }
      return erpRes;
    }

    return new Response(
      JSON.stringify({ found: false, order: null }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    if (e instanceof Response) return e;
    console.error("get-order-by-email error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "未知错误" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
