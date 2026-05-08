import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { createAlertAndNotify } from "../_shared/ops-notify.ts";

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
        results.push({ id: task.id, status: "resolved", order_id: order.id });
        continue;
      }

      const retryCount = Number(task.retry_count ?? 0) + 1;
      const failed = retryCount >= Number(task.max_retries ?? 3);
      await admin.from("order_compensation_tasks").update({
        retry_count: retryCount,
        status: failed ? "failed" : "pending",
        next_run_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        last_error: failed ? "达到最大重试次数，仍未查到订单" : "本次未查到订单",
      }).eq("id", task.id);
      if (failed) {
        await admin.from("emails").update({
          association_status: "not_found",
          priority: "high",
        }).eq("id", task.email_id);
        await createAlertAndNotify(admin, {
          source: "run-compensation-tasks",
          kind: "failed",
          title: "订单补偿失败",
          message: `订单号 ${task.order_no} 重试 ${retryCount} 次仍未查到`,
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
