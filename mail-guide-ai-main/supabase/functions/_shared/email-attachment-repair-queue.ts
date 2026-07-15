import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { isWorkerCancelledError } from "./email-body-repair-queue.ts";

export type AttachmentRepairTaskPriority = "interactive" | "background";
export type AttachmentRepairTaskStatus = "pending" | "running" | "resolved" | "failed" | "skipped";

export type EnqueueAttachmentRepairResult = {
  enqueued: boolean;
  taskId?: string;
  terminal?: boolean;
};

const BACKOFF_MINUTES = [5, 15, 30, 60, 120];

/** emails.attachments 是否已有可下载的 storage_path（防假 resolved） */
export function attachmentsJsonHasValidStoragePath(attachments: unknown): boolean {
  if (!Array.isArray(attachments)) return false;
  return attachments.some((a: unknown) => {
    if (!a || typeof a !== "object") return false;
    const o = a as Record<string, unknown>;
    const path = typeof o.storage_path === "string" ? o.storage_path.trim() : "";
    if (!path) return false;
    const size = o.size;
    if (typeof size === "number" && size <= 0) return false;
    const fn = String(o.filename ?? "").trim().toLowerCase();
    const ct = String(o.contentType ?? "").split(";")[0].trim().toLowerCase();
    if (/^attachment-\d+\./i.test(fn) && ct === "application/octet-stream") return false;
    return true;
  });
}

export async function recoverStaleAttachmentRepairTasks(
  admin: ReturnType<typeof createClient>,
  staleMinutes = 20,
  limit = 50,
): Promise<number> {
  const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();
  const { data: stale, error } = await admin
    .from("email_attachment_repair_tasks")
    .select("id")
    .eq("status", "running")
    .lt("locked_at", cutoff)
    .limit(limit);
  if (error) {
    console.warn("[att-repair] stale query failed:", error.message);
    return 0;
  }

  let recovered = 0;
  for (const task of stale ?? []) {
    const taskId = String((task as { id: string }).id);
    const { error: upErr } = await admin
      .from("email_attachment_repair_tasks")
      .update({
        status: "pending",
        last_error: "stale_running_recovered",
        next_run_at: new Date().toISOString(),
        locked_at: null,
        locked_by: null,
      })
      .eq("id", taskId)
      .eq("status", "running");
    if (!upErr) recovered++;
  }

  // 无 locked_at 的 running（异常中断）一并回收
  const { data: unlocked, error: unlockedErr } = await admin
    .from("email_attachment_repair_tasks")
    .select("id")
    .eq("status", "running")
    .is("locked_at", null)
    .limit(limit);
  if (unlockedErr) {
    console.warn("[att-repair] unlocked running query failed:", unlockedErr.message);
    return recovered;
  }
  for (const task of unlocked ?? []) {
    const taskId = String((task as { id: string }).id);
    const { error: upErr } = await admin
      .from("email_attachment_repair_tasks")
      .update({
        status: "pending",
        last_error: "stale_running_recovered",
        next_run_at: new Date().toISOString(),
        locked_at: null,
        locked_by: null,
      })
      .eq("id", taskId)
      .eq("status", "running");
    if (!upErr) recovered++;
  }
  return recovered;
}

export async function enqueueAttachmentRepairTask(
  admin: ReturnType<typeof createClient>,
  emailId: string,
  reason: string,
  priority: AttachmentRepairTaskPriority = "background",
): Promise<EnqueueAttachmentRepairResult> {
  const { data: email } = await admin
    .from("emails")
    .select("id")
    .eq("id", emailId)
    .maybeSingle();
  if (!email) return { enqueued: false, terminal: true };

  const { data: existing } = await admin
    .from("email_attachment_repair_tasks")
    .select("id, status")
    .eq("email_id", emailId)
    .maybeSingle();

  if (existing && (existing.status === "pending" || existing.status === "running")) {
    return { enqueued: true, taskId: String(existing.id), terminal: false };
  }

  const payload = {
    email_id: emailId,
    status: "pending" as AttachmentRepairTaskStatus,
    priority,
    last_error: reason.slice(0, 500),
    next_run_at: new Date().toISOString(),
    attempt_count: 0,
    locked_at: null,
    locked_by: null,
  };

  const { data: row, error } = await admin
    .from("email_attachment_repair_tasks")
    .upsert(payload, { onConflict: "email_id" })
    .select("id")
    .single();
  if (error) {
    console.error("[enqueueAttachmentRepairTask]", error);
    return { enqueued: false, terminal: true };
  }

  return { enqueued: true, taskId: row?.id != null ? String(row.id) : undefined, terminal: false };
}

export function classifyAttachmentRepairFailure(
  error: string,
  attemptCount: number,
  maxAttempts: number,
): { terminal: boolean; lastError: string } {
  const terminal = attemptCount >= maxAttempts;
  const errText = error.slice(0, 500);
  if (isWorkerCancelledError(errText)) {
    return {
      terminal,
      lastError: terminal
        ? "超大附件补拉多次超时（WorkerRequestCancelled）"
        : "超大附件补拉超时，已安排后台重试",
    };
  }
  return { terminal, lastError: errText };
}

export function nextAttachmentRepairBackoffIso(attemptCount: number): string {
  const idx = Math.min(Math.max(attemptCount, 1), BACKOFF_MINUTES.length) - 1;
  const minutes = BACKOFF_MINUTES[idx];
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}
