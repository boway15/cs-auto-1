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
    return { enqueued: true, taskId: existing.id, terminal: false };
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

  return { enqueued: true, taskId: row?.id, terminal: false };
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
