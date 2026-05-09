// 有单号但未在库中关联（compensating）：收信满 2h 后首次内部预警邮件（去重由 ops_alerts 幂等键保证）
// 每 30 分钟由 pg_cron 触发，仅服务角色

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { createAlertAndNotify } from "../_shared/ops-notify.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const BATCH_LIMIT = Number(Deno.env.get("COMPENSATING_ALERT_BATCH") ?? "40");
const MIN_AGE_MS = 2 * 60 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (token !== SERVICE_KEY) {
      return new Response(JSON.stringify({ error: "仅允许服务角色调用" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const cutoffIso = new Date(Date.now() - MIN_AGE_MS).toISOString();

    const { data: emails, error } = await admin
      .from("emails")
      .select("id, subject, from_email, received_at, business_intent, association_status, ai_summary, ai_entities")
      .eq("association_status", "compensating")
      .lte("received_at", cutoffIso)
      .order("received_at", { ascending: true })
      .limit(BATCH_LIMIT);

    if (error) throw error;

    const results: Array<{ email_id: string; status: string; detail?: string }> = [];

    for (const row of emails ?? []) {
      const { data: task } = await admin
        .from("order_compensation_tasks")
        .select("order_no, status")
        .eq("email_id", row.id)
        .eq("status", "pending")
        .maybeSingle();

      const fromEntities =
        typeof row.ai_entities === "object" && row.ai_entities && "order_no" in row.ai_entities
          ? String((row.ai_entities as Record<string, unknown>).order_no ?? "").trim()
          : "";
      const orderNo = (task?.order_no ?? fromEntities) || null;

      if (!orderNo) {
        results.push({ email_id: row.id, status: "skipped", detail: "no_order_no" });
        continue;
      }

      const msg = [
        `客户提供了订单号但本地/ERP 尚未关联成功，请人工处理或等待补偿任务。`,
        `订单号：${orderNo}`,
        `发件人：${row.from_email ?? "-"}`,
        `主题：${row.subject ?? "-"}`,
        `摘要：${row.ai_summary ?? "-"}`,
        `业务意图：${row.business_intent ?? "-"}`,
      ].join("\n");

      const r = await createAlertAndNotify(admin, {
        source: "schedule-compensating-alerts",
        kind: "order_not_in_erp",
        title: `订单未关联：${orderNo}`,
        message: msg,
        related_email_id: row.id,
        related_order_id: null,
        severity: "warning",
        metadata: {
          order_no: orderNo,
          business_intent: row.business_intent,
          association_status: row.association_status,
        },
      });

      results.push({
        email_id: row.id,
        status: r.deduped && !r.email_sent ? "deduped" : r.email_sent ? "alert_sent" : "alert_recorded",
        detail: r.error ?? undefined,
      });
    }

    return new Response(
      JSON.stringify({
        ok: true,
        scanned: emails?.length ?? 0,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("schedule-compensating-alerts error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
