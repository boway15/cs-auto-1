import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { createAlertAndNotify } from "../_shared/ops-notify.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

async function getActor(req: Request, admin: any) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (token === SERVICE_KEY) return { userId: null, isService: true };
  if (!token) throw new Response(JSON.stringify({ error: "未授权" }), { status: 401, headers: corsHeaders });
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });
  const { data } = await userClient.auth.getUser();
  if (!data.user) throw new Response(JSON.stringify({ error: "未登录" }), { status: 401, headers: corsHeaders });
  const { data: isStaff } = await admin.rpc("is_staff", { _user_id: data.user.id });
  if (!isStaff) throw new Response(JSON.stringify({ error: "权限不足" }), { status: 403, headers: corsHeaders });
  return { userId: data.user.id, isService: false };
}

/** 第三方打标：Shopify 已停用；仅本地 `orders` 状态由 runIntercept 更新，ERP 见 docs/erp-api-requirements.md */
async function applyShopifyTag(_admin: any, _order: any, _action: "hold" | "release", _reason?: string, _category?: string) {
  return { skipped: true, reason: "Shopify 已停用，仅本地订单状态" };
}

async function runIntercept(payload: any, actor: { userId: string | null }, admin: any) {
  const {
    email_id,
    order_id,
    action = "hold",
    intercept_reason,
    reason_category,
    trigger_source = "manual",
  } = payload;
  if (!order_id || !["hold", "release"].includes(action)) throw new Error("参数错误");

  const idempotencyKey = payload.idempotency_key ?? `risk:${email_id ?? "none"}:${order_id}:${action}:${reason_category ?? "manual"}`;
  const { data: existing } = await admin
    .from("risk_intercept_logs")
    .select("*")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (existing?.status === "success") return existing;

  const { data: order, error: orderErr } = await admin
    .from("orders")
    .select("*")
    .eq("id", order_id)
    .single();
  if (orderErr || !order) throw new Error("订单不存在");

  const { data: log, error: logErr } = await admin
    .from("risk_intercept_logs")
    .upsert({
      id: existing?.id,
      email_id: email_id ?? null,
      order_id,
      action,
      intercept_reason: intercept_reason ?? null,
      reason_category: reason_category ?? null,
      trigger_source,
      status: "pending",
      retry_count: existing ? existing.retry_count + 1 : 0,
      operated_by: actor.userId,
      idempotency_key: idempotencyKey,
    }, { onConflict: "idempotency_key" })
    .select()
    .single();
  if (logErr) throw logErr;

  let shopifyResponse: any = null;
  try {
    const updates = action === "hold"
      ? {
          shipping_hold: true,
          hold_reason: intercept_reason ?? null,
          hold_at: new Date().toISOString(),
          hold_by: actor.userId,
        }
      : { shipping_hold: false, hold_reason: null, hold_at: null, hold_by: null };
    await admin.from("orders").update(updates).eq("id", order_id);
    shopifyResponse = await applyShopifyTag(admin, order, action, intercept_reason, reason_category);
    await admin.from("risk_intercept_logs").update({
      status: "success",
      shopify_response: shopifyResponse,
      error_message: null,
    }).eq("id", log.id);
    await admin.from("order_hold_logs").insert({
      order_id,
      email_id: email_id ?? null,
      action,
      reason: intercept_reason ?? null,
      reason_category: reason_category ?? null,
      shopify_synced: !!shopifyResponse?.ok,
      shopify_sync_error: shopifyResponse?.skipped ? shopifyResponse.reason : null,
      performed_by: actor.userId,
    });
    if (email_id) {
      await admin.from("emails").update({
        priority: "urgent",
        risk_level: "high",
        processing_status: action === "hold" ? "risk_intercepted" : "associated",
      }).eq("id", email_id);
      await admin.from("email_processing_events").insert({
        email_id,
        event_type: "risk_intercepted",
        title: action === "hold" ? "风控拦截成功" : "风控解除成功",
        detail: intercept_reason ?? null,
        metadata: { order_id, shopify_response: shopifyResponse },
      });
    }
    return { ...log, status: "success", shopify_response: shopifyResponse };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryCount = (log.retry_count ?? 0) + 1;
    const finalStatus = retryCount <= 1 ? "retrying" : "failed";
    await admin.from("risk_intercept_logs").update({
      status: finalStatus,
      retry_count: retryCount,
      shopify_response: shopifyResponse,
      error_message: message,
    }).eq("id", log.id);
    if (finalStatus === "failed") {
      // 与 process-email 共享去重维度：失败仅产生一条 ops_alerts 与一封通知邮件
      await createAlertAndNotify(admin, {
        source: "risk-intercept",
        kind: "failed",
        title: "风控拦截失败",
        message,
        related_email_id: email_id ?? null,
        related_order_id: order_id,
        severity: "critical",
        metadata: { log_id: log.id, retry_count: retryCount },
      });
      if (email_id) await admin.from("emails").update({ priority: "urgent" }).eq("id", email_id);
    }
    throw error;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  try {
    const actor = await getActor(req, admin);
    const payload = await req.json();
    const result = await runIntercept(payload, actor, admin);
    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("risk-intercept error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
