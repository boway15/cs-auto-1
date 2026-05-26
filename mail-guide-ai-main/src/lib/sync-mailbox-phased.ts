import { supabase } from "@/lib/supabase";
import { formatFunctionsInvokeError } from "@/lib/format-functions-invoke-error";

export type SyncMailboxPhase = "incremental" | "historical" | "repair_body";

export type SyncMailboxInvokeBody = {
  mailbox_id: string;
  force_bulk?: boolean;
  repair_empty_body?: boolean;
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

function buildInvokeBody(mailboxId: string, phase: SyncMailboxPhase): SyncMailboxInvokeBody {
  const body: SyncMailboxInvokeBody = { mailbox_id: mailboxId };
  if (phase === "historical") body.force_bulk = true;
  if (phase === "repair_body") body.repair_empty_body = true;
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
 * 手动同步三阶段：增量（新邮件全文）→ 历史轻量回补 → 小批量补空正文。
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

  const phases: SyncMailboxPhase[] = ["incremental", "historical", "repair_body"];

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
            /WorkerRequestCancelled|request has been cancelled/i.test(invokeErr)
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
        } else {
          totalRepaired += repaired;
          emptyBodyRemaining = emptyRemain;
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
        } else if (repaired === 0 && emptyRemain === 0) {
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
