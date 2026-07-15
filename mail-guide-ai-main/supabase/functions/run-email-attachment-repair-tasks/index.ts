import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  attachmentsJsonHasValidStoragePath,
  classifyAttachmentRepairFailure,
  nextAttachmentRepairBackoffIso,
  recoverStaleAttachmentRepairTasks,
} from "../_shared/email-attachment-repair-queue.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_KEY = Deno.env.get("CRON_SERVICE_ROLE_KEY");
function parseEnvPositiveInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name)?.trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const BATCH_LIMIT = parseEnvPositiveInt("MAIL_ATTACHMENT_REPAIR_BATCH_LIMIT", 1);
const STALE_MINUTES = parseEnvPositiveInt("MAIL_ATTACHMENT_REPAIR_STALE_LOCK_MINUTES", 20);
const WORKER_ID = `att-repair-${crypto.randomUUID().slice(0, 8)}`;

function isAuthorizedServiceToken(token: string): boolean {
  if (!token) return false;
  if (token === SERVICE_KEY) return true;
  if (CRON_KEY && token === CRON_KEY) return true;
  return false;
}

async function markRetryOrFailed(
  admin: ReturnType<typeof createClient>,
  locked: { id: string; attempt_count: number | null; max_attempts: number | null },
  failureText: string,
  results: Record<string, unknown>[],
) {
  const maxAttempts = locked.max_attempts ?? 6;
  const attempts = locked.attempt_count ?? 1;
  const classification = classifyAttachmentRepairFailure(failureText, attempts, maxAttempts);
  if (classification.terminal) {
    await admin.from("email_attachment_repair_tasks").update({
      status: "failed",
      last_error: classification.lastError,
      locked_at: null,
      locked_by: null,
    }).eq("id", locked.id);
    results.push({
      task_id: locked.id,
      status: "failed",
      error: classification.lastError,
      terminal: true,
    });
  } else {
    await admin.from("email_attachment_repair_tasks").update({
      status: "pending",
      last_error: classification.lastError,
      next_run_at: nextAttachmentRepairBackoffIso(attempts),
      locked_at: null,
      locked_by: null,
    }).eq("id", locked.id);
    results.push({
      task_id: locked.id,
      status: "retry",
      error: classification.lastError,
    });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!isAuthorizedServiceToken(token)) {
      return new Response(JSON.stringify({ error: "仅允许服务角色执行附件补拉任务" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const nowIso = new Date().toISOString();

    const staleRecovered = await recoverStaleAttachmentRepairTasks(admin, STALE_MINUTES);

    const { data: tasks, error: pickErr } = await admin
      .from("email_attachment_repair_tasks")
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
        .from("email_attachment_repair_tasks")
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
        .select("attachments")
        .eq("id", locked.email_id)
        .maybeSingle();
      if (attachmentsJsonHasValidStoragePath(emailRow?.attachments)) {
        await admin.from("email_attachment_repair_tasks").update({
          status: "resolved",
          repaired_at: new Date().toISOString(),
          last_error: null,
          locked_at: null,
          locked_by: null,
        }).eq("id", locked.id);
        results.push({ task_id: locked.id, status: "resolved_already_has_attachments" });
        continue;
      }

      try {
        const resp = await fetch(`${SUPABASE_URL}/functions/v1/sync-mailbox`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${SERVICE_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            repair_email_id: locked.email_id,
            repair_full: true,
            repair_task_id: locked.id,
          }),
        });
        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(text.slice(0, 500));
        }
        const body = await resp.json().catch(() => ({}));
        const row = Array.isArray(body?.results) ? body.results[0] : null;
        const repaired = Number(row?.repaired ?? 0);

        const { data: afterRow } = await admin
          .from("emails")
          .select("attachments")
          .eq("id", locked.email_id)
          .maybeSingle();
        const hasStorage = attachmentsJsonHasValidStoragePath(afterRow?.attachments);

        if (repaired > 0 && hasStorage) {
          await admin.from("email_attachment_repair_tasks").update({
            status: "resolved",
            repaired_at: new Date().toISOString(),
            last_error: null,
            locked_at: null,
            locked_by: null,
          }).eq("id", locked.id);
          results.push({ task_id: locked.id, status: "resolved", repaired });
        } else if (repaired > 0 && !hasStorage) {
          await markRetryOrFailed(
            admin,
            locked,
            "repaired_claimed_but_no_storage_path",
            results,
          );
        } else {
          const failureText =
            (typeof row?.error === "string" && row.error) ||
            (typeof row?.queue_reason === "string" && row.queue_reason) ||
            "附件补拉未完成";
          await markRetryOrFailed(admin, locked, failureText, results);
        }
      } catch (e) {
        const errText = e instanceof Error ? e.message : String(e);
        await markRetryOrFailed(admin, locked, errText, results);
      }
    }

    return new Response(JSON.stringify({
      processed: results.length,
      stale_recovered: staleRecovered,
      results,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("run-email-attachment-repair-tasks error:", error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
