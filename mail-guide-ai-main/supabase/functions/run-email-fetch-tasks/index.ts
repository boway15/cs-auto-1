import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { nextFetchBackoffIso } from "../_shared/email-fetch-queue.ts";
import { enqueueAttachmentRepairTask } from "../_shared/email-attachment-repair-queue.ts";
import { hasReadableEmailBody } from "../_shared/mime-parse.ts";
import { emailNeedsMediaBinarySync } from "../_shared/email-attachment-presence.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_KEY = Deno.env.get("CRON_SERVICE_ROLE_KEY");
const WORKER_ID = `fetch-${crypto.randomUUID().slice(0, 8)}`;

function parseEnvPositiveInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name)?.trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const BATCH_LIMIT = parseEnvPositiveInt("MAIL_FETCH_TASK_BATCH_LIMIT", 1);

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
      return new Response(JSON.stringify({ error: "仅允许服务角色执行邮件拉取任务" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const nowIso = new Date().toISOString();

    const { data: tasks, error: pickErr } = await admin
      .from("email_fetch_tasks")
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
        .from("email_fetch_tasks")
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
      if (lockErr || !locked?.email_id) {
        results.push({ task_id: task.id, status: "lock_skipped" });
        continue;
      }

      const emailId = locked.email_id;
      const { data: emailRow } = await admin
        .from("emails")
        .select("body_text, body_html, has_attachment, attachments")
        .eq("id", emailId)
        .maybeSingle();

      const hasBody = hasReadableEmailBody(emailRow?.body_text, emailRow?.body_html);
      const needsAtt = emailRow ? emailNeedsMediaBinarySync(emailRow) : false;

      if (hasBody && !needsAtt) {
        await admin.from("email_fetch_tasks").update({
          status: "resolved",
          fetched_at: nowIso,
          last_error: null,
          locked_at: null,
          locked_by: null,
        }).eq("id", locked.id);
        results.push({ task_id: locked.id, status: "resolved_already_complete" });
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
            repair_email_id: emailId,
            repair_full: true,
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
          .select("body_text, body_html, has_attachment, attachments")
          .eq("id", emailId)
          .maybeSingle();
        const bodyOk = hasReadableEmailBody(afterRow?.body_text, afterRow?.body_html);
        const stillNeedAtt = afterRow ? emailNeedsMediaBinarySync(afterRow) : false;

        if (stillNeedAtt) {
          await enqueueAttachmentRepairTask(
            admin,
            emailId,
            "fetch_task_attachment_followup",
            "background",
          );
        }

        const maxAttempts = locked.max_attempts ?? 6;
        const attempts = locked.attempt_count ?? 1;
        if (bodyOk || repaired > 0) {
          await admin.from("email_fetch_tasks").update({
            status: stillNeedAtt ? "pending" : "resolved",
            fetched_at: bodyOk ? nowIso : null,
            last_error: stillNeedAtt ? "正文已拉取，附件仍待后台补拉" : null,
            next_run_at: stillNeedAtt ? nextFetchBackoffIso(attempts) : nowIso,
            locked_at: null,
            locked_by: null,
          }).eq("id", locked.id);
          results.push({
            task_id: locked.id,
            status: stillNeedAtt ? "partial_attachment_queued" : "resolved",
            repaired,
          });
        } else if (attempts >= maxAttempts) {
          await admin.from("email_fetch_tasks").update({
            status: "failed",
            last_error: "拉取后正文仍为空",
            locked_at: null,
            locked_by: null,
          }).eq("id", locked.id);
          results.push({ task_id: locked.id, status: "failed", terminal: true });
        } else {
          await admin.from("email_fetch_tasks").update({
            status: "pending",
            last_error: "拉取后正文仍为空，将重试",
            next_run_at: nextFetchBackoffIso(attempts),
            locked_at: null,
            locked_by: null,
          }).eq("id", locked.id);
          results.push({ task_id: locked.id, status: "retry" });
        }
      } catch (e) {
        const errText = e instanceof Error ? e.message : String(e);
        const maxAttempts = locked.max_attempts ?? 6;
        const attempts = locked.attempt_count ?? 1;
        if (attempts >= maxAttempts) {
          await admin.from("email_fetch_tasks").update({
            status: "failed",
            last_error: errText.slice(0, 500),
            locked_at: null,
            locked_by: null,
          }).eq("id", locked.id);
          results.push({ task_id: locked.id, status: "failed", error: errText });
        } else {
          await admin.from("email_fetch_tasks").update({
            status: "pending",
            last_error: errText.slice(0, 500),
            next_run_at: nextFetchBackoffIso(attempts),
            locked_at: null,
            locked_by: null,
          }).eq("id", locked.id);
          results.push({ task_id: locked.id, status: "retry", error: errText });
        }
      }
    }

    return new Response(JSON.stringify({ processed: results.length, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("run-email-fetch-tasks error:", error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
