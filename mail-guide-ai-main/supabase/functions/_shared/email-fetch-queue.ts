import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export type FetchTaskPriority = "interactive" | "background";
export type FetchTaskStatus = "pending" | "running" | "resolved" | "failed" | "skipped";

export type EnqueueFetchTaskResult = {
  enqueued: boolean;
  taskId?: string;
  terminal?: boolean;
};

const BACKOFF_MINUTES = [3, 10, 20, 40, 90];

export async function enqueueEmailFetchTask(
  admin: ReturnType<typeof createClient>,
  payload: {
    mailbox_id: string;
    uid: number;
    message_id: string;
    email_id?: string | null;
    reason?: string;
    priority?: FetchTaskPriority;
    metadata?: Record<string, unknown>;
  },
): Promise<EnqueueFetchTaskResult> {
  const { data: existing } = await admin
    .from("email_fetch_tasks")
    .select("id, status")
    .eq("mailbox_id", payload.mailbox_id)
    .eq("uid", payload.uid)
    .maybeSingle();

  if (existing && (existing.status === "pending" || existing.status === "running")) {
    return { enqueued: true, taskId: existing.id, terminal: false };
  }

  const row = {
    mailbox_id: payload.mailbox_id,
    uid: payload.uid,
    message_id: payload.message_id,
    email_id: payload.email_id ?? null,
    status: "pending" as FetchTaskStatus,
    priority: payload.priority ?? "background",
    last_error: (payload.reason ?? "discovered").slice(0, 500),
    next_run_at: new Date().toISOString(),
    attempt_count: 0,
    locked_at: null,
    locked_by: null,
    metadata: payload.metadata ?? {},
  };

  const { data, error } = await admin
    .from("email_fetch_tasks")
    .upsert(row, { onConflict: "mailbox_id,uid" })
    .select("id")
    .single();

  if (error) {
    console.error("[enqueueEmailFetchTask]", error);
    return { enqueued: false, terminal: true };
  }
  return { enqueued: true, taskId: data?.id, terminal: false };
}

export function nextFetchBackoffIso(attemptCount: number): string {
  const idx = Math.min(Math.max(attemptCount, 1), BACKOFF_MINUTES.length) - 1;
  const minutes = BACKOFF_MINUTES[idx];
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}
