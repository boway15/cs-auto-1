/**
 * Docker 常驻：附件补拉（进程内 IMAP，不受 Edge CPU/墙钟硬杀）。
 * 推荐与邮件正文 Worker 一样用 docker-compose.worker.yml 启动。
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  attachmentsJsonHasValidStoragePath,
  classifyAttachmentRepairFailure,
  nextAttachmentPartialResumeIso,
  nextAttachmentRepairBackoffIso,
  recoverStaleAttachmentRepairTasks,
} from "../../supabase/functions/_shared/email-attachment-repair-queue.ts";
import { repairEmailAttachmentsById } from "../../supabase/functions/_shared/imap-attachment-repair.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://host.docker.internal:8000";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY") ?? "";
const WORKER_ID = `docker-att-repair-${crypto.randomUUID().slice(0, 8)}`;
const BATCH_LIMIT = parsePositiveInt("EMAIL_ATTACHMENT_REPAIR_WORKER_BATCH", 1);
const POLL_INTERVAL_MS = parsePositiveInt("EMAIL_ATTACHMENT_REPAIR_WORKER_INTERVAL_MS", 20_000);
const STALE_LOCK_MINUTES = parsePositiveInt("EMAIL_ATTACHMENT_REPAIR_STALE_LOCK_MINUTES", 15);
const PARTS_PER_INVOKE = parsePositiveInt("MAIL_SYNC_ATTACHMENT_PARTS_PER_INVOKE", 2);
const RUN_ONCE = Deno.env.get("EMAIL_ATTACHMENT_REPAIR_WORKER_ONCE") === "true";

if (!SERVICE_KEY) {
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or SERVICE_ROLE_KEY");
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

type RepairTask = {
  id: string;
  email_id: string;
  status: string;
  attempt_count: number | null;
  max_attempts: number | null;
};

function parsePositiveInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name)?.trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function pickDueTasks(): Promise<RepairTask[]> {
  const { data, error } = await admin
    .from("email_attachment_repair_tasks")
    .select("id, email_id, status, attempt_count, max_attempts")
    .eq("status", "pending")
    .lte("next_run_at", nowIso())
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(BATCH_LIMIT);
  if (error) throw error;
  return (data ?? []) as RepairTask[];
}

async function lockTask(task: RepairTask): Promise<RepairTask | null> {
  const attemptCount = (task.attempt_count ?? 0) + 1;
  const { data, error } = await admin
    .from("email_attachment_repair_tasks")
    .update({
      status: "running",
      locked_at: nowIso(),
      locked_by: WORKER_ID,
      attempt_count: attemptCount,
    })
    .eq("id", task.id)
    .eq("status", "pending")
    .select("id, email_id, status, attempt_count, max_attempts")
    .maybeSingle();
  if (error) {
    console.warn("[att-worker] lock failed:", task.id, error.message);
    return null;
  }
  return data as RepairTask | null;
}

async function markFailedOrRetry(task: RepairTask, errorText: string) {
  const attempts = task.attempt_count ?? 1;
  const maxAttempts = task.max_attempts ?? 10;
  const classification = classifyAttachmentRepairFailure(errorText, attempts, maxAttempts);
  const storedError = classification.lastError.slice(0, 500);
  if (classification.terminal) {
    await admin.from("email_attachment_repair_tasks").update({
      status: "failed",
      last_error: storedError,
      locked_at: null,
      locked_by: null,
    }).eq("id", task.id);
    return { status: "failed", error: storedError, terminal: true };
  }
  await admin.from("email_attachment_repair_tasks").update({
    status: "pending",
    last_error: storedError,
    next_run_at: nextAttachmentRepairBackoffIso(attempts, errorText),
    locked_at: null,
    locked_by: null,
  }).eq("id", task.id);
  return { status: "retry", error: storedError };
}

async function processTask(task: RepairTask) {
  const locked = await lockTask(task);
  if (!locked) return { task_id: task.id, status: "lock_skipped" };

  const result = await repairEmailAttachmentsById(admin, locked.email_id, {
    maxPartsPerInvoke: PARTS_PER_INVOKE,
  });

  if (result.status === "repaired" || result.status === "skip_already_has") {
    const { data: after } = await admin
      .from("emails")
      .select("attachments")
      .eq("id", locked.email_id)
      .maybeSingle();
    if (!attachmentsJsonHasValidStoragePath(after?.attachments)) {
      return await markFailedOrRetry(locked, "repaired_claimed_but_no_storage_path");
    }
    await admin.from("email_attachment_repair_tasks").update({
      status: "resolved",
      repaired_at: nowIso(),
      last_error: null,
      locked_at: null,
      locked_by: null,
    }).eq("id", locked.id);
    return { task_id: locked.id, status: "resolved", stored: result.storedCount };
  }

  if (result.status === "partial") {
    await admin.from("email_attachment_repair_tasks").update({
      status: "pending",
      last_error: `partial_resume remaining=${result.remainingParts}`,
      next_run_at: nextAttachmentPartialResumeIso(),
      locked_at: null,
      locked_by: null,
      attempt_count: Math.max((locked.attempt_count ?? 1) - 1, 0),
    }).eq("id", locked.id);
    return {
      task_id: locked.id,
      status: "partial_resume",
      stored: result.storedCount,
      remaining: result.remainingParts,
    };
  }

  return await markFailedOrRetry(
    locked,
    result.status === "failed" || result.status === "still_missing" ||
        result.status === "skip_no_uid" || result.status === "queued_large"
      ? result.error
      : "attachment_repair_failed",
  );
}

async function runOnce() {
  await recoverStaleAttachmentRepairTasks(admin, STALE_LOCK_MINUTES);
  const tasks = await pickDueTasks();
  const results = [];
  for (const task of tasks) {
    results.push(await processTask(task));
  }
  console.log(JSON.stringify({ processed: results.length, results }));
}

if (RUN_ONCE) {
  await runOnce();
} else {
  console.log("[att-worker] started", {
    SUPABASE_URL,
    BATCH_LIMIT,
    POLL_INTERVAL_MS,
    STALE_LOCK_MINUTES,
    PARTS_PER_INVOKE,
  });
  while (true) {
    try {
      await runOnce();
    } catch (e) {
      console.error("[att-worker] loop failed:", e);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
