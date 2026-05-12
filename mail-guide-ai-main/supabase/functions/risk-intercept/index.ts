import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { createAlertAndNotify } from "../_shared/ops-notify.ts";
import { blockOrderByOrderId, isErpHttpConfigured } from "../_shared/erp-client.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const corsJsonHeaders = {
  ...corsHeaders,
  "Content-Type": "application/json",
};

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

/** PostgrestError 等常为普通对象，直接 String 会得到 [object Object] */
function serializeUnknown(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    if (typeof o.message === "string") {
      const head = typeof o.code === "string" ? `[${o.code}] ${o.message}` : o.message;
      if (typeof o.details === "string" && o.details) return `${head}：${o.details}`;
      if (typeof o.hint === "string" && o.hint) return `${head}（${o.hint}）`;
      return head;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

function erpResponseSummary(erp: Record<string, unknown> | null): string {
  if (!erp || typeof erp !== "object") return "";
  if (String(erp.erp) === "skipped") {
    const r = String(erp.reason ?? "");
    if (r === "erp_env_incomplete") return "ERP：未配置完整，本次未调网关（仅本地标记）";
    if (r === "no_release_api_documented") return "ERP：放行未调接口（仅本地更新）";
    if (r === "none") return "";
    return `ERP：已跳过 — ${r}`;
  }
  const data = erp.data;
  if (data && typeof data === "object") {
    const m = (data as Record<string, unknown>).message;
    if (typeof m === "string" && m.trim()) return `ERP 返回：${m.trim()}`;
  }
  const bits: string[] = [];
  if (typeof erp.success === "boolean") bits.push(`success=${erp.success}`);
  const code = erp.code ?? erp.businessCode;
  if (code !== undefined && code !== null) bits.push(`code=${String(code)}`);
  if (erp._httpStatus !== undefined && erp._httpStatus !== null) bits.push(`HTTP ${String(erp._httpStatus)}`);
  const trace = erp.traceId ?? erp.trace_id;
  if (trace) bits.push(`traceId=${String(trace)}`);
  if (bits.length) return `ERP 返回：${bits.join("，")}`;
  try {
    const s = JSON.stringify(erp);
    return s.length > 600 ? `ERP 返回（节选）：${s.slice(0, 600)}…` : `ERP 返回：${s}`;
  } catch {
    return "ERP：已调用";
  }
}

function reasonCategoryLabel(cat: string | null | undefined): string {
  const map: Record<string, string> = {
    cancel_order: "取消订单",
    change_address: "修改地址",
    change_product: "更换商品",
    payment_issue: "付款/风控",
    risk_review: "风控复核",
    other: "其他",
  };
  if (!cat) return "";
  return map[String(cat)] ?? String(cat);
}

function buildRiskTimelineDetail(params: {
  orderNo: string;
  action: "hold" | "release";
  intercept_reason: string | null | undefined;
  reason_category: string | null | undefined;
  erpResponse: Record<string, unknown> | null;
  trigger_source: string;
  outcomeNote?: string;
  /** 无本地 orders 行，仅邮件单号调 ERP */
  emailProvidedOnly?: boolean;
}): string {
  const lines: string[] = [];
  if (params.orderNo) lines.push(`订单号：${params.orderNo}`);
  if (params.emailProvidedOnly) {
    lines.push("依据：邮件提供单号（未关联本地订单）");
  }
  const cv = reasonCategoryLabel(params.reason_category);
  if (cv) lines.push(`原因分类：${cv}`);
  if (params.intercept_reason?.trim()) lines.push(`说明：${params.intercept_reason.trim()}`);
  const erpLine = erpResponseSummary(params.erpResponse);
  if (erpLine) lines.push(erpLine);
  if (params.trigger_source === "manual") lines.push("来源：人工操作（工作台）");
  else if (params.trigger_source) lines.push(`来源：${params.trigger_source}`);
  if (params.outcomeNote?.trim()) lines.push(params.outcomeNote.trim());
  return lines.join("\n").trim().slice(0, 8000);
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

async function getActor(req: Request, admin: any) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (token === SERVICE_KEY) return { userId: null, isService: true };
  if (!token) throw new Response(JSON.stringify({ error: "未授权" }), { status: 401, headers: corsJsonHeaders });
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });
  const { data } = await userClient.auth.getUser();
  if (!data.user) throw new Response(JSON.stringify({ error: "未登录" }), { status: 401, headers: corsJsonHeaders });
  const { data: isStaff } = await admin.rpc("is_staff", { _user_id: data.user.id });
  if (!isStaff) throw new Response(JSON.stringify({ error: "权限不足" }), { status: 403, headers: corsJsonHeaders });
  return { userId: data.user.id, isService: false };
}

/** 第三方打标：Shopify 已停用；仅本地 `orders` 状态由 runInterceptLinkedOrder 更新，ERP 见 docs/erp-api-requirements.md */
async function applyShopifyTag(_admin: any, _order: any, _action: "hold" | "release", _reason?: string, _category?: string) {
  return { skipped: true, reason: "Shopify 已停用，仅本地订单状态" };
}

/** 已关联本地 orders：更新 shipping_hold、写 order_hold_logs */
async function runInterceptLinkedOrder(payload: any, actor: { userId: string | null }, admin: any) {
  const {
    email_id,
    order_id,
    action,
    intercept_reason,
    reason_category,
    trigger_source = "manual",
  } = payload;

  const idempotencyKey = payload.idempotency_key ??
    `risk:${email_id ?? "none"}:${order_id}:${action}:${reason_category ?? "manual"}`;
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

  const refNo = String(order.order_no ?? "").trim() || null;

  const { data: log, error: logErr } = await admin
    .from("risk_intercept_logs")
    .upsert({
      id: existing?.id,
      email_id: email_id ?? null,
      order_id,
      referenced_order_no: refNo,
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
  let erpResponse: Record<string, unknown> | null = null;
  try {
    if (action === "hold" && isErpHttpConfigured()) {
      const br = await blockOrderByOrderId(String(order.order_no ?? ""));
      erpResponse = { ...(br.envelope as Record<string, unknown>), _httpStatus: br.httpStatus };
      await admin.from("risk_intercept_logs").update({ erp_response: erpResponse }).eq("id", log.id);
      if (!br.ok) {
        const hint = String(br.envelope.data?.message ?? br.rawText?.slice(0, 400) ?? "");
        throw new Error(`ERP 拦截未确认成功 HTTP ${br.httpStatus} ${hint}`);
      }
    } else if (action === "hold") {
      erpResponse = { erp: "skipped", reason: "erp_env_incomplete" };
      await admin.from("risk_intercept_logs").update({ erp_response: erpResponse }).eq("id", log.id);
    } else if (action === "release") {
      erpResponse = { erp: "skipped", reason: "no_release_api_documented" };
      await admin.from("risk_intercept_logs").update({ erp_response: erpResponse }).eq("id", log.id);
    }

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
      erp_response: erpResponse ?? { erp: "skipped", reason: "none" },
      error_message: null,
      referenced_order_no: refNo,
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
      const orderNo = String(order.order_no ?? "");
      const isManual = trigger_source === "manual";
      const timelineTitle =
        action === "hold"
          ? (isManual ? "人工暂停发货（成功）" : "风控拦截成功")
          : (isManual ? "人工解除暂停发货（成功）" : "风控解除成功");
      const timelineDetail = buildRiskTimelineDetail({
        orderNo,
        action,
        intercept_reason,
        reason_category,
        erpResponse: erpResponse ?? null,
        trigger_source,
        emailProvidedOnly: false,
      });
      try {
        await admin.from("email_processing_events").insert({
          email_id,
          event_type: "risk_intercepted",
          actor_type: actor.userId ? "user" : "system",
          actor_id: actor.userId,
          title: timelineTitle,
          detail: timelineDetail || null,
          metadata: {
            order_id,
            order_no: orderNo,
            action,
            trigger_source,
            shopify_response: shopifyResponse,
            erp_response: erpResponse,
            email_provided_only: false,
          },
        });
      } catch (e) {
        console.error("risk-intercept: email_processing_events insert failed:", e);
      }
    }
    return { ...log, status: "success", shopify_response: shopifyResponse, erp_response: erpResponse };
  } catch (error) {
    const message = serializeUnknown(error);
    const retryCount = (log.retry_count ?? 0) + 1;
    const finalStatus = retryCount <= 1 ? "retrying" : "failed";
    await admin.from("risk_intercept_logs").update({
      status: finalStatus,
      retry_count: retryCount,
      shopify_response: shopifyResponse,
      erp_response: erpResponse,
      error_message: message,
    }).eq("id", log.id);
    if (finalStatus === "failed") {
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
    if (email_id) {
      const orderNo = String(order.order_no ?? "");
      const isManual = trigger_source === "manual";
      const failTitle =
        action === "hold"
          ? (isManual ? "人工暂停发货（失败）" : "风控拦截（失败）")
          : (isManual ? "人工解除暂停发货（失败）" : "风控解除（失败）");
      const timelineDetail = buildRiskTimelineDetail({
        orderNo,
        action,
        intercept_reason,
        reason_category,
        erpResponse: erpResponse ?? null,
        trigger_source,
        outcomeNote: `失败原因：${message}`,
        emailProvidedOnly: false,
      });
      try {
        await admin.from("email_processing_events").insert({
          email_id,
          event_type: "risk_intercept_failed",
          actor_type: actor.userId ? "user" : "system",
          actor_id: actor.userId,
          title: failTitle,
          detail: timelineDetail || `失败原因：${message}`,
          metadata: {
            order_id,
            order_no: orderNo,
            action,
            trigger_source,
            erp_response: erpResponse,
            error_message: message,
            log_id: log.id,
            status: finalStatus,
            email_provided_only: false,
          },
        });
      } catch (e) {
        console.error("risk-intercept: failure timeline insert failed:", e);
      }
    }
    throw error;
  }
}

function normalizeOrderNoForMatch(s: unknown): string {
  return String(s ?? "").trim().toLowerCase();
}

/**
 * 邮件单号拦截成功后：若该邮件已关联本地订单且单号一致，则同步 `shipping_hold` 与流水，
 * 工作台才能展示「恢复发货」（解除仍为本地 release，不向 ERP 发 release）。
 */
async function syncEmailProvidedHoldToLinkedOrders(
  admin: any,
  params: {
    email_id: string;
    order_no: string;
    intercept_reason: string | null | undefined;
    reason_category: string | null | undefined;
    trigger_source: string;
    actor: { userId: string | null };
    shopifyResponse: Record<string, unknown> | null;
    risk_log_id: string;
  },
): Promise<number> {
  const target = normalizeOrderNoForMatch(params.order_no);
  if (!target) return 0;

  const { data: linkRows, error: linkErr } = await admin
    .from("email_order_links")
    .select("order_id, orders ( id, order_no, shipping_hold )")
    .eq("email_id", params.email_id);
  if (linkErr) {
    console.error("risk-intercept: syncEmailProvidedHoldToLinkedOrders links query failed:", linkErr);
    return 0;
  }

  const seen = new Set<string>();
  let synced = 0;
  let firstOrderId: string | null = null;

  for (const row of linkRows ?? []) {
    const o = row?.orders;
    if (!o?.id) continue;
    const oid = String(o.id);
    if (seen.has(oid)) continue;
    if (normalizeOrderNoForMatch(o.order_no) !== target) continue;
    seen.add(oid);
    if (!firstOrderId) firstOrderId = oid;

    const alreadyHeld = !!o.shipping_hold;
    const updates = {
      shipping_hold: true,
      hold_reason: params.intercept_reason ?? null,
      hold_at: new Date().toISOString(),
      hold_by: params.actor.userId,
    };
    const { error: upErr } = await admin.from("orders").update(updates).eq("id", oid);
    if (upErr) {
      console.error("risk-intercept: sync hold to order failed:", oid, upErr);
      continue;
    }
    synced++;
    if (!alreadyHeld) {
      const sr = params.shopifyResponse;
      await admin.from("order_hold_logs").insert({
        order_id: oid,
        email_id: params.email_id,
        action: "hold",
        reason: params.intercept_reason ?? null,
        reason_category: params.reason_category ?? null,
        shopify_synced: !!(sr as any)?.ok,
        shopify_sync_error: (sr as any)?.skipped ? String((sr as any).reason ?? "") : null,
        performed_by: params.actor.userId,
      });
    }
  }

  if (firstOrderId) {
    await admin.from("risk_intercept_logs").update({ order_id: firstOrderId }).eq("id", params.risk_log_id).is(
      "order_id",
      null,
    );
  }

  return synced;
}

/** 无本地 orders 行时仍可按邮件单号调 ERP hold；若该邮件已关联同号本地订单则同步本地 hold（见 syncEmailProvidedHoldToLinkedOrders） */
async function runInterceptEmailProvidedOrderNo(payload: any, actor: { userId: string | null }, admin: any) {
  const {
    email_id,
    intercept_reason,
    reason_category,
    trigger_source = "manual",
  } = payload;
  const order_no = String(payload.order_no ?? "").trim();
  const action = "hold" as const;

  const idempotencyKey = payload.idempotency_key ??
    `risk:email:${email_id}:only_no:${order_no}:${action}:${reason_category ?? "manual"}`;

  const { data: existing } = await admin
    .from("risk_intercept_logs")
    .select("*")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (existing?.status === "success") {
    const linkedHoldSynced = await syncEmailProvidedHoldToLinkedOrders(admin, {
      email_id,
      order_no,
      intercept_reason,
      reason_category,
      trigger_source,
      actor,
      shopifyResponse: (existing.shopify_response ?? null) as Record<string, unknown> | null,
      risk_log_id: String(existing.id),
    });
    return { ...existing, linked_orders_hold_synced: linkedHoldSynced };
  }

  const { data: log, error: logErr } = await admin
    .from("risk_intercept_logs")
    .upsert({
      id: existing?.id,
      email_id,
      order_id: null,
      referenced_order_no: order_no,
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
  let erpResponse: Record<string, unknown> | null = null;
  try {
    if (isErpHttpConfigured()) {
      const br = await blockOrderByOrderId(order_no);
      erpResponse = { ...(br.envelope as Record<string, unknown>), _httpStatus: br.httpStatus };
      await admin.from("risk_intercept_logs").update({ erp_response: erpResponse }).eq("id", log.id);
      if (!br.ok) {
        const hint = String(br.envelope.data?.message ?? br.rawText?.slice(0, 400) ?? "");
        throw new Error(`ERP 拦截未确认成功 HTTP ${br.httpStatus} ${hint}`);
      }
    } else {
      erpResponse = { erp: "skipped", reason: "erp_env_incomplete" };
      await admin.from("risk_intercept_logs").update({ erp_response: erpResponse }).eq("id", log.id);
    }

    shopifyResponse = { skipped: true, reason: "无本地订单行，仅邮件单号拦截" };
    await admin.from("risk_intercept_logs").update({
      status: "success",
      shopify_response: shopifyResponse,
      erp_response: erpResponse ?? { erp: "skipped", reason: "none" },
      error_message: null,
      referenced_order_no: order_no,
    }).eq("id", log.id);

    await admin.from("emails").update({
      priority: "urgent",
      risk_level: "high",
      processing_status: "risk_intercepted",
    }).eq("id", email_id);

    const isManual = trigger_source === "manual";
    const timelineTitle = isManual ? "人工暂停发货（成功，邮件单号）" : "风控拦截成功（邮件单号）";
    const timelineDetail = buildRiskTimelineDetail({
      orderNo: order_no,
      action: "hold",
      intercept_reason,
      reason_category,
      erpResponse: erpResponse ?? null,
      trigger_source,
      emailProvidedOnly: true,
    });
    try {
      await admin.from("email_processing_events").insert({
        email_id,
        event_type: "risk_intercepted",
        actor_type: actor.userId ? "user" : "system",
        actor_id: actor.userId,
        title: timelineTitle,
        detail: timelineDetail || null,
        metadata: {
          order_id: null,
          order_no,
          referenced_order_no: order_no,
          action: "hold",
          trigger_source,
          shopify_response: shopifyResponse,
          erp_response: erpResponse,
          email_provided_only: true,
        },
      });
    } catch (e) {
      console.error("risk-intercept: email_processing_events insert failed:", e);
    }

    const linkedHoldSynced = await syncEmailProvidedHoldToLinkedOrders(admin, {
      email_id,
      order_no,
      intercept_reason,
      reason_category,
      trigger_source,
      actor,
      shopifyResponse: shopifyResponse as Record<string, unknown> | null,
      risk_log_id: String(log.id),
    });

    return {
      ...log,
      status: "success",
      shopify_response: shopifyResponse,
      erp_response: erpResponse,
      linked_orders_hold_synced: linkedHoldSynced,
    };
  } catch (error) {
    const message = serializeUnknown(error);
    const retryCount = (log.retry_count ?? 0) + 1;
    const finalStatus = retryCount <= 1 ? "retrying" : "failed";
    await admin.from("risk_intercept_logs").update({
      status: finalStatus,
      retry_count: retryCount,
      shopify_response: shopifyResponse,
      erp_response: erpResponse,
      error_message: message,
    }).eq("id", log.id);
    if (finalStatus === "failed") {
      await createAlertAndNotify(admin, {
        source: "risk-intercept",
        kind: "failed",
        title: "风控拦截失败（邮件单号）",
        message,
        related_email_id: email_id,
        related_order_id: null,
        severity: "critical",
        metadata: { log_id: log.id, retry_count: retryCount, referenced_order_no: order_no },
      });
      await admin.from("emails").update({ priority: "urgent" }).eq("id", email_id);
    }
    const isManual = trigger_source === "manual";
    const failTitle = isManual ? "人工暂停发货（失败，邮件单号）" : "风控拦截（失败，邮件单号）";
    const timelineDetail = buildRiskTimelineDetail({
      orderNo: order_no,
      action: "hold",
      intercept_reason,
      reason_category,
      erpResponse: erpResponse ?? null,
      trigger_source,
      outcomeNote: `失败原因：${message}`,
      emailProvidedOnly: true,
    });
    try {
      await admin.from("email_processing_events").insert({
        email_id,
        event_type: "risk_intercept_failed",
        actor_type: actor.userId ? "user" : "system",
        actor_id: actor.userId,
        title: failTitle,
        detail: timelineDetail || `失败原因：${message}`,
        metadata: {
          order_id: null,
          order_no,
          referenced_order_no: order_no,
          action: "hold",
          trigger_source,
          erp_response: erpResponse,
          error_message: message,
          log_id: log.id,
          status: finalStatus,
          email_provided_only: true,
        },
      });
    } catch (e) {
      console.error("risk-intercept: failure timeline insert failed:", e);
    }
    throw error;
  }
}

async function runIntercept(payload: any, actor: { userId: string | null }, admin: any) {
  const action = payload.action ?? "hold";
  if (!["hold", "release"].includes(action)) throw new Error("参数错误");

  const orderIdRaw = payload.order_id != null ? String(payload.order_id).trim() : "";
  const orderId = orderIdRaw && isUuid(orderIdRaw) ? orderIdRaw : "";

  const orderNoFromPayload = String(payload.order_no ?? "").trim();
  const emailIdRaw = payload.email_id != null ? String(payload.email_id).trim() : "";
  const email_id = emailIdRaw && isUuid(emailIdRaw) ? emailIdRaw : null;

  if (orderId) {
    return await runInterceptLinkedOrder({ ...payload, order_id: orderId, email_id: email_id ?? payload.email_id }, actor, admin);
  }

  if (action === "release") {
    throw new Error("参数错误：解除拦截需要提供已关联的 order_id");
  }

  if (orderNoFromPayload && email_id) {
    return await runInterceptEmailProvidedOrderNo({ ...payload, email_id, order_no: orderNoFromPayload, action: "hold" }, actor, admin);
  }

  throw new Error("参数错误：请提供 order_id，或同时提供 email_id 与 order_no（仅支持 hold）");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  try {
    const actor = await getActor(req, admin);
    const payload = await req.json();
    const result = await runIntercept(payload, actor, admin);
    return new Response(JSON.stringify({ ok: true, result }), {
      headers: corsJsonHeaders,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("risk-intercept error:", error);
    return new Response(JSON.stringify({ error: serializeUnknown(error) }), {
      status: 500,
      headers: corsJsonHeaders,
    });
  }
});
