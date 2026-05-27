import { supabase } from "@/lib/supabase";
import { formatFunctionsInvokeError } from "@/lib/format-functions-invoke-error";

export type SyncMailboxPhase = "incremental" | "historical" | "repair_body" | "repair_attachments";

export type SyncMailboxInvokeBody = {
  mailbox_id: string;
  force_bulk?: boolean;
  repair_empty_body?: boolean;
  repair_missing_attachments?: boolean;
};

export type RepairSingleEmailInvokeBody = {
  repair_email_id: string;
  queue_attachment_repair?: boolean;
};

export type SyncMailboxResultRow = {
  mailbox?: string;
  fetched?: number;
  inserted?: number;
  total?: number;
  remaining?: number;
  repaired?: number;
  empty_body_remaining?: number;
  mode?: string;
  error?: string;
  queued?: boolean;
  queue_reason?: string;
};

export type PhasedSyncProgress = {
  phase: SyncMailboxPhase;
  batch: number;
  round: number;
  inserted: number;
  remaining: number;
  repaired?: number;
  emptyBodyRemaining?: number;
};

export type PhasedSyncOutcome = {
  totalInserted: number;
  historyRemaining: number;
  emptyBodyRemaining: number;
  totalRepaired: number;
  failed: boolean;
  errorMessage?: string;
};

const DEFAULT_MAX_ROUNDS = 50;
const DEFAULT_MAX_BATCHES = 10;
const DEFAULT_ROUND_DELAY_MS = 1500;
const DEFAULT_BATCH_DELAY_MS = 20_000;
const DEFAULT_WORKER_CANCEL_RETRY_DELAY_MS = 8000;

export function isWorkerRequestCancelledError(message: string | null | undefined): boolean {
  return /WorkerRequestCancelled|request has been cancelled/i.test(String(message ?? ""));
}

/** 单封补拉失败时是否应改走后台附件队列（含 Edge non-2xx / 超时） */
export function shouldEnqueueAttachmentRepairOnFailure(
  message: string | null | undefined,
): boolean {
  const msg = String(message ?? "");
  if (!msg) return false;
  if (isWorkerRequestCancelledError(msg)) return true;
  return /non-2xx|502|504|gateway|timeout|cancelled|cpu time|worker failed/i.test(msg);
}

function buildInvokeBody(mailboxId: string, phase: SyncMailboxPhase): SyncMailboxInvokeBody {
  const body: SyncMailboxInvokeBody = { mailbox_id: mailboxId };
  if (phase === "historical") body.force_bulk = true;
  if (phase === "repair_body") body.repair_empty_body = true;
  if (phase === "repair_attachments") body.repair_missing_attachments = true;
  return body;
}

export async function invokeSyncMailboxPhase(
  mailboxId: string,
  phase: SyncMailboxPhase,
): Promise<{ row: SyncMailboxResultRow | null; errorMessage?: string }> {
  const { data, error } = await supabase.functions.invoke("sync-mailbox", {
    body: buildInvokeBody(mailboxId, phase),
  });
  if (error) {
    return { row: null, errorMessage: await formatFunctionsInvokeError(error) };
  }
  if (data?.error) {
    return { row: null, errorMessage: String(data.error) };
  }
  const row = (data?.results?.[0] ?? null) as SyncMailboxResultRow | null;
  if (row?.error) {
    return { row: null, errorMessage: row.error };
  }
  if (!row) {
    return { row: null, errorMessage: "未获取到同步结果" };
  }
  return { row };
}

/** 单封补拉：用于占位附件/正文异常时快速修复当前邮件 */
export async function invokeRepairSingleEmail(
  emailId: string,
): Promise<{ row: SyncMailboxResultRow | null; errorMessage?: string }> {
  const body: RepairSingleEmailInvokeBody = { repair_email_id: emailId };
  const { data, error } = await supabase.functions.invoke("sync-mailbox", { body });
  if (error) {
    const rawMessage =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : "";
    return {
      row: null,
      errorMessage: rawMessage || (await formatFunctionsInvokeError(error)),
    };
  }
  if (data?.error) {
    return { row: null, errorMessage: String(data.error) };
  }
  const row = (data?.results?.[0] ?? null) as SyncMailboxResultRow | null;
  if (row?.error) {
    return { row: null, errorMessage: row.error };
  }
  if (!row) {
    return { row: null, errorMessage: "未获取到补拉结果" };
  }
  return { row };
}

export async function enqueueAttachmentRepairForEmail(
  emailId: string,
): Promise<{ queued: boolean; taskId?: string; errorMessage?: string }> {
  const body: RepairSingleEmailInvokeBody = {
    repair_email_id: emailId,
    queue_attachment_repair: true,
  };
  const { data, error } = await supabase.functions.invoke("sync-mailbox", { body });
  if (error) {
    return { queued: false, errorMessage: await formatFunctionsInvokeError(error) };
  }
  if (data?.error) {
    return { queued: false, errorMessage: String(data.error) };
  }
  return {
    queued: Boolean(data?.queued),
    taskId: typeof data?.task_id === "string" ? data.task_id : undefined,
  };
}

export async function invokeRepairSingleEmailWithRetry(options: {
  emailId: string;
  maxRetries?: number;
  retryDelayMs?: number;
  wait?: (ms: number) => Promise<void>;
}): Promise<{ row: SyncMailboxResultRow | null; errorMessage?: string; retries: number }> {
  const {
    emailId,
    maxRetries = 2,
    retryDelayMs = DEFAULT_WORKER_CANCEL_RETRY_DELAY_MS,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  let retries = 0;
  while (true) {
    const result = await invokeRepairSingleEmail(emailId);
    if (!result.errorMessage || !isWorkerRequestCancelledError(result.errorMessage) || retries >= maxRetries) {
      return { ...result, retries };
    }
    retries++;
    await wait(retryDelayMs);
  }
}

export type RunPhasedMailboxSyncOptions = {
  mailboxId: string;
  maxRoundsPerPhase?: number;
  maxBatches?: number;
  roundDelayMs?: number;
  batchDelayMs?: number;
  workerCancelRetryDelayMs?: number;
  onProgress?: (progress: PhasedSyncProgress) => void;
  wait?: (ms: number) => Promise<void>;
};

/**
 * 手动同步四阶段：增量（新邮件全文）→ 历史轻量回补 → 补空正文 → 补占位附件。
 */
export async function runPhasedMailboxSync(
  options: RunPhasedMailboxSyncOptions,
): Promise<PhasedSyncOutcome> {
  const {
    mailboxId,
    maxRoundsPerPhase = DEFAULT_MAX_ROUNDS,
    maxBatches = DEFAULT_MAX_BATCHES,
    roundDelayMs = DEFAULT_ROUND_DELAY_MS,
    batchDelayMs = DEFAULT_BATCH_DELAY_MS,
    workerCancelRetryDelayMs = DEFAULT_WORKER_CANCEL_RETRY_DELAY_MS,
    onProgress,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  let totalInserted = 0;
  let totalRepaired = 0;
  let historyRemaining = 0;
  let emptyBodyRemaining = 0;
  let failed = false;
  let errorMessage: string | undefined;

  const phases: SyncMailboxPhase[] = ["incremental", "historical", "repair_body", "repair_attachments"];

  for (const phase of phases) {
    if (failed) break;
    let workerCancelRetries = 0;

    for (let batch = 1; batch <= maxBatches; batch++) {
      let rounds = 0;
      let phaseDone = false;

      while (rounds < maxRoundsPerPhase) {
        rounds++;
        const { row, errorMessage: invokeErr } = await invokeSyncMailboxPhase(mailboxId, phase);
        if (invokeErr) {
          if (
            phase !== "repair_body" &&
            workerCancelRetries < 2 &&
            isWorkerRequestCancelledError(invokeErr)
          ) {
            workerCancelRetries++;
            rounds--;
            await wait(workerCancelRetryDelayMs);
            continue;
          }
          failed = true;
          errorMessage = invokeErr;
          phaseDone = true;
          break;
        }

        const inserted = row?.inserted ?? 0;
        const remaining = row?.remaining ?? 0;
        const repaired = row?.repaired ?? 0;
        const emptyRemain = row?.empty_body_remaining ?? remaining;

        if (phase === "incremental") {
          totalInserted += inserted;
        } else if (phase === "historical") {
          totalInserted += inserted;
          historyRemaining = remaining;
        } else if (phase === "repair_body") {
          totalRepaired += repaired;
          emptyBodyRemaining = emptyRemain;
        } else {
          totalRepaired += repaired;
        }

        onProgress?.({
          phase,
          batch,
          round: rounds,
          inserted,
          remaining,
          repaired,
          emptyBodyRemaining: emptyRemain,
        });

        if (phase === "incremental") {
          if (inserted === 0 && remaining === 0) {
            phaseDone = true;
            break;
          }
        } else if (phase === "historical") {
          if (remaining === 0) {
            phaseDone = true;
            break;
          }
        } else if (phase === "repair_body") {
          if (repaired === 0 && emptyRemain === 0) {
            phaseDone = true;
            break;
          }
        } else if (repaired === 0 && remaining === 0) {
          phaseDone = true;
          break;
        }

        await wait(rounds % 10 === 0 ? workerCancelRetryDelayMs : roundDelayMs);
      }

      if (failed || phaseDone) break;
      if (batch < maxBatches) {
        await wait(batchDelayMs);
      }
    }
  }

  return {
    totalInserted,
    historyRemaining,
    emptyBodyRemaining,
    totalRepaired,
    failed,
    errorMessage,
  };
}
