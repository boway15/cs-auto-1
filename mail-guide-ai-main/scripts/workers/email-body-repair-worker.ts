import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  classifyRepairFailure,
  finalizePostBodyRepair,
  nextRepairBackoffIso,
  recordBodyRepairEvent,
} from "../../supabase/functions/_shared/email-body-repair-queue.ts";
import {
  isUidNotFoundRepairError,
  terminalUidNotFoundMessage,
} from "../../supabase/functions/_shared/imap-message-id.ts";
import { repairEmailBodyTextOnly } from "../../supabase/functions/_shared/imap-text-body-repair.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://host.docker.internal:8000";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY") ?? "";
const WORKER_ID = `docker-body-repair-${crypto.randomUUID().slice(0, 8)}`;
const BATCH_LIMIT = parsePositiveInt("EMAIL_BODY_REPAIR_WORKER_BATCH", 1);
const POLL_INTERVAL_MS = parsePositiveInt("EMAIL_BODY_REPAIR_WORKER_INTERVAL_MS", 30_000);
const STALE_LOCK_MINUTES = parsePositiveInt("EMAIL_BODY_REPAIR_STALE_LOCK_MINUTES", 10);
const RUN_ONCE = Deno.env.get("EMAIL_BODY_REPAIR_WORKER_ONCE") === "true";

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

async function recoverStaleRunningTasks() {
  const cutoff = new Date(Date.now() - STALE_LOCK_MINUTES * 60_000).toISOString();
  const { data: stale, error } = await admin
    .from("email_body_repair_tasks")
    .select("id, email_id, locked_at, locked_by")
    .eq("status", "running")
    .lt("locked_at", cutoff)
    .limit(20);

  if (error) {
    console.warn("[body-worker] recover stale query failed:", error.message);
    return;
  }

  for (const task of stale ?? []) {
    const { error: upErr } = await admin
      .from("email_body_repair_tasks")
      .update({
        status: "pending",
        last_error: "stale_running_recovered",
        next_run_at: nowIso(),
        locked_at: null,
        locked_by: null,
      })
      .eq("id", task.id)
      .eq("status", "running");
    if (upErr) {
      console.warn("[body-worker] recover stale update failed:", task.id, upErr.message);
      continue;
    }
    await recordBodyRepairEvent(
      admin,
      task.email_id,
      "body_repair_stale_recovered",
      "正文补拉任务运行超时，已恢复为待重试",
      undefined,
      { task_id: task.id, locked_by: task.locked_by ?? null },
    );
  }
}

async function pickDueTasks(): Promise<RepairTask[]> {
  const { data, error } = await admin
    .from("email_body_repair_tasks")
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
    .from("email_body_repair_tasks")
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
    console.warn("[body-worker] lock failed:", task.id, error.message);
    return null;
  }
  return data as RepairTask | null;
}

async function markResolved(task: RepairTask, metadata: Record<string, unknown>) {
  const resolvedAt = nowIso();
  await admin.from("email_body_repair_tasks").update({
    status: "resolved",
    repaired_at: resolvedAt,
    last_error: null,
    locked_at: null,
    locked_by: null,
  }).eq("id", task.id);

  await recordBodyRepairEvent(
    admin,
    task.email_id,
    "body_repair_succeeded",
    "Docker Worker 正文补拉成功（仅正文，未下载附件）",
    undefined,
    { task_id: task.id, ...metadata },
  );

  const post = await finalizePostBodyRepair(admin, SUPABASE_URL, SERVICE_KEY, task.email_id);
  if (!post.ok) {
    console.warn("[body-worker] post process failed:", task.email_id, post.error);
  }
  return post.ok;
}

async function markSkippedHasBody(task: RepairTask) {
  const post = await finalizePostBodyRepair(admin, SUPABASE_URL, SERVICE_KEY, task.email_id);
  await admin.from("email_body_repair_tasks").update({
    status: "resolved",
    repaired_at: nowIso(),
    last_error: null,
    locked_at: null,
    locked_by: null,
  }).eq("id", task.id);
  await recordBodyRepairEvent(
    admin,
    task.email_id,
    "body_repair_skipped_has_body",
    post.ok ? "正文已存在，已补跑分析/订单关联" : "正文已存在，后处理待重试",
    post.error,
    { task_id: task.id },
  );
}

async function markFailedOrRetry(task: RepairTask, errorText: string) {
  const attempts = task.attempt_count ?? 1;
  const maxAttempts = task.max_attempts ?? 5;
  const classification = classifyRepairFailure(errorText, attempts, maxAttempts);
  const storedError = classification.lastError.slice(0, 500);

  if (classification.terminal) {
    await admin.from("email_body_repair_tasks").update({
      status: "failed",
      last_error: storedError,
      locked_at: null,
      locked_by: null,
    }).eq("id", task.id);
    await recordBodyRepairEvent(
      admin,
      task.email_id,
      classification.eventType,
      classification.eventTitle,
      storedError,
      { task_id: task.id, attempt_count: attempts, terminal: true },
    );
    return { status: "failed", error: storedError, terminal: true };
  }

  await admin.from("email_body_repair_tasks").update({
    status: "pending",
    last_error: storedError,
    next_run_at: nextRepairBackoffIso(attempts),
    locked_at: null,
    locked_by: null,
  }).eq("id", task.id);
  await recordBodyRepairEvent(
    admin,
    task.email_id,
    classification.eventType,
    classification.eventTitle,
    storedError,
    { task_id: task.id, attempt_count: attempts },
  );
  return {
    status: "retry",
    error: storedError,
    hint: isUidNotFoundRepairError(errorText) ? terminalUidNotFoundMessage() : undefined,
  };
}

async function processTask(task: RepairTask) {
  const locked = await lockTask(task);
  if (!locked) return { task_id: task.id, status: "lock_skipped" };

  await recordBodyRepairEvent(
    admin,
    locked.email_id,
    "body_repair_started",
    "Docker Worker 后台正文补拉开始",
    undefined,
    { task_id: locked.id, worker_id: WORKER_ID },
  );

  const result = await repairEmailBodyTextOnly(admin, locked.email_id);
  if (result.status === "repaired") {
    const postProcessed = await markResolved(locked, {
      body_text_length: result.bodyTextLength,
      body_html_length: result.bodyHtmlLength,
    });
    return { task_id: locked.id, status: "resolved", post_processed: postProcessed };
  }
  if (result.status === "skip_not_empty") {
    await markSkippedHasBody(locked);
    return { task_id: locked.id, status: "resolved_already_has_body" };
  }
  return await markFailedOrRetry(locked, result.error);
}

async function runOnce() {
  await recoverStaleRunningTasks();
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
  console.log("[body-worker] started", {
    SUPABASE_URL,
    BATCH_LIMIT,
    POLL_INTERVAL_MS,
    STALE_LOCK_MINUTES,
  });
  while (true) {
    try {
      await runOnce();
    } catch (e) {
      console.error("[body-worker] loop failed:", e);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
