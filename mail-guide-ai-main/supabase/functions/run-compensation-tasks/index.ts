import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { createAlertAndNotify } from "../_shared/ops-notify.ts";
import {
  erpEnvelopeOmsQuerySucceeded,
  isErpOmsConfigured,
  queryOrderInfo,
} from "../_shared/erp-client.ts";
import { upsertOrderFromOmsData } from "../_shared/erp-order-sync.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (token !== SERVICE_KEY) {
      return new Response(JSON.stringify({ error: "仅允许服务角色执行补偿任务" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: tasks, error } = await admin
      .from("order_compensation_tasks")
      .select("*")
      .eq("status", "pending")
      .lte("next_run_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(50);
    if (error) throw error;

    const results = [];
    for (const task of tasks ?? []) {
      const { data: emailAssoc } = await admin
        .from("emails")
        .select("association_status")
        .eq("id", task.email_id)
        .maybeSingle();
      if (emailAssoc?.association_status === "manual_unlink") {
        await admin.from("order_compensation_tasks").update({
          status: "failed",
          last_error: "邮件已人工解除关联，停止补偿",
        }).eq("id", task.id);
        results.push({ id: task.id, status: "skipped_manual_unlink" });
        continue;
      }

      if (isErpOmsConfigured()) {
        try {
          const { data: em } = await admin.from("emails").select("from_email").eq("id", task.email_id).maybeSingle();
          const from = String(em?.from_email ?? "").trim();
          if (from) {
            const r = await queryOrderInfo(from, task.order_no ?? "");
            const inner = r.envelope.data;
            if (r.ok && inner && typeof inner === "object" && erpEnvelopeOmsQuerySucceeded(r.envelope)) {
              await upsertOrderFromOmsData(admin, inner as Record<string, unknown>, from);
            }
          }
        } catch (e) {
          console.error("run-compensation-tasks OMS:", e);
        }
      }

      const { data: order } = await admin
        .from("orders")
        .select("*")
        .ilike("order_no", task.order_no)
        .maybeSingle();

      if (order) {
        await admin.from("email_order_links").upsert({
          email_id: task.email_id,
          order_id: order.id,
          link_source: "compensation",
          confidence: 0.95,
          metadata: { task_id: task.id, order_no: task.order_no },
        }, { onConflict: "email_id,order_id" });
        await admin.from("order_compensation_tasks").update({
          status: "resolved",
          resolved_order_id: order.id,
          last_error: null,
        }).eq("id", task.id);
        await admin.from("emails").update({
          association_status: "linked",
          processing_status: "associated",
        }).eq("id", task.email_id);
        await admin.from("email_processing_events").insert({
          email_id: task.email_id,
          event_type: "compensation_resolved",
          title: `补偿任务关联订单 ${order.order_no}`,
          metadata: { task_id: task.id, order_id: order.id },
        });

        // 若邮件意图为取消/改地址，关联成功后立即触发风控拦截
        const { data: emailRow } = await admin
          .from("emails")
          .select("business_intent")
          .eq("id", task.email_id)
          .maybeSingle();
        const mustIntercept =
          emailRow?.business_intent === "order_cancel" ||
          emailRow?.business_intent === "address_change";
        if (mustIntercept) {
          try {
            const interceptResp = await fetch(`${SUPABASE_URL}/functions/v1/risk-intercept`, {
              method: "POST",
              headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                email_id: task.email_id,
                order_id: order.id,
                action: "hold",
                intercept_reason: "补偿任务关联成功后自动拦截",
                reason_category: emailRow.business_intent,
                trigger_source: "auto",
              }),
            });
            if (!interceptResp.ok) {
              const errText = await interceptResp.text();
              console.error("compensation auto-intercept failed:", errText);
              await admin.from("email_processing_events").insert({
                email_id: task.email_id,
                event_type: "risk_intercept_failed",
                title: "补偿关联后自动拦截失败",
                detail: errText,
                metadata: { order_id: order.id },
              });
            }
          } catch (e) {
            console.error("compensation auto-intercept error:", e);
          }
        }

        results.push({ id: task.id, status: "resolved", order_id: order.id });
        continue;
      }

      const retryCount = Number(task.retry_count ?? 0) + 1;
      const failed = retryCount >= Number(task.max_retries ?? 10);
      await admin.from("order_compensation_tasks").update({
        retry_count: retryCount,
        status: failed ? "failed" : "pending",
        next_run_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        last_error: failed ? "达到最大重试次数，仍未查到订单" : "本次未查到订单",
      }).eq("id", task.id);
      if (failed) {
        await admin.from("emails").update({
          association_status: "not_provided",
          priority: "high",
        }).eq("id", task.email_id);
        await createAlertAndNotify(admin, {
          source: "run-compensation-tasks",
          kind: "failed",
          title: "订单补偿失败",
          message: `订单号 ${task.order_no} 重试 ${retryCount} 次仍未查到，邮件关联状态已置为未提供`,
          related_email_id: task.email_id,
          severity: "warning",
          metadata: { task_id: task.id, order_no: task.order_no, retry_count: retryCount },
        });
      }
      results.push({ id: task.id, status: failed ? "failed" : "pending", retry_count: retryCount });
    }

    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("run-compensation-tasks error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
