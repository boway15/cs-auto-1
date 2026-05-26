import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { isUidNotFoundRepairError, terminalUidNotFoundMessage } from "./imap-message-id.ts";

export type BodyRepairTaskPriority = "interactive" | "background";
export type BodyRepairTaskStatus = "pending" | "running" | "resolved" | "failed" | "skipped";

export type EnqueueBodyRepairResult = {
  enqueued: boolean;
  taskId?: string;
  /**  true：不应再提示“已入队等待” */
  terminal?: boolean;
};

const BACKOFF_MINUTES = [5, 15, 30, 60, 120];

export function isWorkerCancelledError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /WorkerRequestCancelled|request has been cancelled/i.test(msg);
}

export function friendlyRepairError(err: unknown): string {
  if (isWorkerCancelledError(err)) {
    return "邮箱响应较慢或邮件较大，已加入后台补拉队列，请稍后刷新或重新打开";
  }
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/IMAP read timeout|IMAP connect timeout/i.test(msg)) {
    return "连接邮箱超时，已加入后台补拉队列";
  }
  if (/still empty|未解析出正文/i.test(msg)) {
    return msg;
  }
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

export async function recordBodyRepairEvent(
  admin: ReturnType<typeof createClient>,
  emailId: string,
  eventType: string,
  title: string,
  detail?: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await admin.from("email_processing_events").insert({
    email_id: emailId,
    event_type: eventType,
    actor_type: "system",
    title,
    detail: detail ?? null,
    metadata,
  });
  if (error) console.warn("[body-repair-event]", eventType, error.message);
}

/** 入队或刷新已有 pending 任务（每封邮件唯一） */
export async function enqueueBodyRepairTask(
  admin: ReturnType<typeof createClient>,
  emailId: string,
  reason: string,
  priority: BodyRepairTaskPriority = "background",
): Promise<EnqueueBodyRepairResult> {
  const { data: email } = await admin
    .from("emails")
    .select("id, association_status")
    .eq("id", emailId)
    .maybeSingle();
  if (!email) return { enqueued: false, terminal: true };

  if (email.association_status === "manual_unlink") {
    await admin.from("email_body_repair_tasks").upsert({
      email_id: emailId,
      status: "skipped",
      priority,
      last_error: "人工解除关联，不自动补正文",
      next_run_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    }, { onConflict: "email_id" });
    return { enqueued: false, terminal: true };
  }

  const { data: existing } = await admin
    .from("email_body_repair_tasks")
    .select("id, status")
    .eq("email_id", emailId)
    .maybeSingle();

  if (existing && (existing.status === "pending" || existing.status === "running")) {
    return { enqueued: true, taskId: existing.id, terminal: false };
  }

  const payload = {
    email_id: emailId,
    status: "pending" as BodyRepairTaskStatus,
    priority,
    last_error: reason.slice(0, 500),
    next_run_at: new Date().toISOString(),
    attempt_count: 0,
    locked_at: null,
    locked_by: null,
  };

  const { data: row, error } = await admin
    .from("email_body_repair_tasks")
    .upsert(payload, { onConflict: "email_id" })
    .select("id")
    .single();

  if (error) {
    console.error("[enqueueBodyRepairTask]", error);
    return { enqueued: false, terminal: true };
  }

  await recordBodyRepairEvent(admin, emailId, "body_repair_queued", "正文补拉已加入后台队列", reason, {
    priority,
    task_id: row?.id,
  });

  return { enqueued: true, taskId: row?.id, terminal: false };
}

export type RepairFailureClassification = {
  terminal: boolean;
  eventType: string;
  eventTitle: string;
  lastError: string;
};

/** worker 失败分类：UID 未命中 vs 可重试 */
export function classifyRepairFailure(
  error: string,
  attemptCount: number,
  maxAttempts: number,
): RepairFailureClassification {
  const errText = error.slice(0, 500);
  if (isUidNotFoundRepairError(errText)) {
    const terminal = attemptCount >= maxAttempts;
    return {
      terminal,
      eventType: terminal ? "body_repair_failed_terminal" : "body_repair_uid_not_found",
      eventTitle: terminal
        ? "后台正文补拉失败（邮箱中找不到原邮件）"
        : "后台正文补拉：未在邮箱中定位到原邮件，将重试",
      lastError: terminal ? terminalUidNotFoundMessage() : errText,
    };
  }
  const terminal = attemptCount >= maxAttempts;
  return {
    terminal,
    eventType: terminal ? "body_repair_failed_terminal" : "body_repair_retry_scheduled",
    eventTitle: terminal ? "后台正文补拉失败（已达最大重试）" : "后台正文补拉失败，已安排重试",
    lastError: errText,
  };
}

export function nextRepairBackoffIso(attemptCount: number): string {
  const idx = Math.min(Math.max(attemptCount, 1), BACKOFF_MINUTES.length) - 1;
  const minutes = BACKOFF_MINUTES[idx];
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

export async function triggerPostRepairProcessing(
  supabaseUrl: string,
  serviceKey: string,
  emailId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/process-email`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email_id: emailId, after_body_repair: true }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: text.slice(0, 500) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 正文已就绪后：触发 process-email 并更新队列 post_processed_at */
export async function finalizePostBodyRepair(
  admin: ReturnType<typeof createClient>,
  supabaseUrl: string,
  serviceKey: string,
  emailId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data: existing } = await admin
    .from("email_body_repair_tasks")
    .select("post_processed_at")
    .eq("email_id", emailId)
    .maybeSingle();
  if (existing?.post_processed_at) {
    return { ok: true };
  }

  const post = await triggerPostRepairProcessing(supabaseUrl, serviceKey, emailId);
  const now = new Date().toISOString();

  if (post.ok) {
    await admin.from("email_body_repair_tasks").upsert({
      email_id: emailId,
      status: "resolved",
      repaired_at: now,
      post_processed_at: now,
      last_error: null,
      next_run_at: now,
    }, { onConflict: "email_id" });
    await recordBodyRepairEvent(
      admin,
      emailId,
      "body_repair_post_processed",
      "正文补拉后处理完成（分析/订单关联）",
    );
  } else {
    await admin.from("email_body_repair_tasks").upsert({
      email_id: emailId,
      status: "pending",
      last_error: `post_process: ${post.error ?? "unknown"}`.slice(0, 500),
      next_run_at: now,
    }, { onConflict: "email_id" });
    await recordBodyRepairEvent(
      admin,
      emailId,
      "body_repair_post_process_failed",
      "正文补拉后处理失败",
      post.error,
    );
  }
  return post;
}
