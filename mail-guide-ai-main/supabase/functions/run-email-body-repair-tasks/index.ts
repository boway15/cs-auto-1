import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  classifyRepairFailure,
  finalizePostBodyRepair,
  nextRepairBackoffIso,
  recordBodyRepairEvent,
} from "../_shared/email-body-repair-queue.ts";
import {
  isUidNotFoundRepairError,
  terminalUidNotFoundMessage,
} from "../_shared/imap-message-id.ts";
import { repairEmailBodyTextOnly } from "../_shared/imap-text-body-repair.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_KEY = Deno.env.get("CRON_SERVICE_ROLE_KEY");
const BATCH_LIMIT = 1;
const WORKER_ID = `body-repair-${crypto.randomUUID().slice(0, 8)}`;

function isAuthorizedServiceToken(token: string): boolean {
  if (!token) return false;
  if (token === SERVICE_KEY) return true;
  if (CRON_KEY && token === CRON_KEY) return true;
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!isAuthorizedServiceToken(token)) {
      return new Response(JSON.stringify({ error: "仅允许服务角色执行正文补拉任务" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const nowIso = new Date().toISOString();

    const { data: tasks, error: pickErr } = await admin
      .from("email_body_repair_tasks")
      .select("*")
      .eq("status", "pending")
      .lte("next_run_at", nowIso)
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(BATCH_LIMIT);
    if (pickErr) throw pickErr;

    const results: Record<string, unknown>[] = [];

    for (const task of tasks ?? []) {
      const { data: locked, error: lockErr } = await admin
        .from("email_body_repair_tasks")
        .update({
          status: "running",
          locked_at: nowIso,
          locked_by: WORKER_ID,
          attempt_count: (task.attempt_count ?? 0) + 1,
        })
        .eq("id", task.id)
        .eq("status", "pending")
        .select("id, email_id, attempt_count, max_attempts")
        .maybeSingle();

      if (lockErr || !locked) {
        results.push({ task_id: task.id, status: "lock_skipped" });
        continue;
      }

      const { data: emailRow } = await admin
        .from("emails")
        .select("body_text, body_html, association_status")
        .eq("id", locked.email_id)
        .maybeSingle();

      const hasBody = Boolean(String(emailRow?.body_text ?? "").trim() || String(emailRow?.body_html ?? "").trim());
      if (hasBody) {
        const { data: taskMeta } = await admin
          .from("email_body_repair_tasks")
          .select("post_processed_at")
          .eq("id", locked.id)
          .maybeSingle();
        let postProcessed = Boolean(taskMeta?.post_processed_at);
        if (!postProcessed) {
          const post = await finalizePostBodyRepair(admin, SUPABASE_URL, SERVICE_KEY, locked.email_id);
          postProcessed = post.ok;
        } else {
          await admin.from("email_body_repair_tasks").update({
            status: "resolved",
            repaired_at: nowIso,
            last_error: null,
          }).eq("id", locked.id);
        }
        await recordBodyRepairEvent(
          admin,
          locked.email_id,
          "body_repair_skipped_has_body",
          postProcessed
            ? "正文已存在，已补跑分析/订单关联"
            : "正文已存在，补拉跳过；后处理待重试",
        );
        results.push({
          task_id: locked.id,
          status: "resolved_already_has_body",
          post_processed: postProcessed,
        });
        continue;
      }

      if (emailRow?.association_status === "manual_unlink") {
        await admin.from("email_body_repair_tasks").update({
          status: "skipped",
          last_error: "人工解除关联",
        }).eq("id", locked.id);
        results.push({ task_id: locked.id, status: "skipped_manual_unlink" });
        continue;
      }

      const repairResult = await repairEmailBodyTextOnly(admin, locked.email_id);

      if (repairResult.status === "repaired") {
        await admin.from("email_body_repair_tasks").update({
          status: "resolved",
          repaired_at: new Date().toISOString(),
          last_error: null,
        }).eq("id", locked.id);
        await recordBodyRepairEvent(
          admin,
          locked.email_id,
          "body_repair_succeeded",
          "后台正文补拉成功（仅正文，未下载附件）",
          undefined,
          {
            body_text_length: repairResult.bodyTextLength,
            body_html_length: repairResult.bodyHtmlLength,
          },
        );
        const post = await finalizePostBodyRepair(admin, SUPABASE_URL, SERVICE_KEY, locked.email_id);
        results.push({
          task_id: locked.id,
          status: "resolved",
          post_processed: post.ok,
        });
        continue;
      }

      if (repairResult.status === "skip_not_empty") {
        const post = await finalizePostBodyRepair(admin, SUPABASE_URL, SERVICE_KEY, locked.email_id);
        results.push({
          task_id: locked.id,
          status: "resolved_already_has_body",
          post_processed: post.ok,
        });
        continue;
      }

      const errText = String(repairResult.error ?? "补拉失败");
      const maxAttempts = locked.max_attempts ?? 5;
      const attempts = locked.attempt_count ?? 1;
      const classification = classifyRepairFailure(errText, attempts, maxAttempts);
      const storedError = classification.lastError.slice(0, 500);

      if (classification.terminal) {
        await admin.from("email_body_repair_tasks").update({
          status: "failed",
          last_error: storedError,
          locked_at: null,
          locked_by: null,
        }).eq("id", locked.id);
        await recordBodyRepairEvent(
          admin,
          locked.email_id,
          classification.eventType,
          classification.eventTitle,
          storedError,
          { attempt_count: attempts, terminal: true },
        );
        results.push({
          task_id: locked.id,
          status: "failed",
          error: storedError,
          terminal: true,
        });
      } else {
        await admin.from("email_body_repair_tasks").update({
          status: "pending",
          last_error: storedError,
          next_run_at: nextRepairBackoffIso(attempts),
          locked_at: null,
          locked_by: null,
        }).eq("id", locked.id);
        await recordBodyRepairEvent(
          admin,
          locked.email_id,
          classification.eventType,
          classification.eventTitle,
          storedError,
          { attempt_count: attempts },
        );
        results.push({
          task_id: locked.id,
          status: "retry",
          error: storedError,
          hint: isUidNotFoundRepairError(errText) ? terminalUidNotFoundMessage() : undefined,
        });
      }
    }

    return new Response(JSON.stringify({ processed: results.length, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("run-email-body-repair-tasks error:", error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
