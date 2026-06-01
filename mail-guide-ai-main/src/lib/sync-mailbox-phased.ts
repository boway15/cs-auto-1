import { supabase } from "@/lib/supabase";
import { formatFunctionsInvokeError } from "@/lib/format-functions-invoke-error";

export type SyncMailboxPhase = "incremental" | "historical" | "repair_body" | "repair_attachments";

export type SyncMailboxInvokeBody = {
  mailbox_id: string;
  force_bulk?: boolean;
  repair_empty_body?: boolean;
  repair_missing_attachments?: boolean;
  /** YYYY-MM-DD，仅补同步该日（近 30 天） */
  sync_on_date?: string;
  /** 可选：仅补该发件人，如 stevehortz@gmail.com */
  sync_from_email?: string;
  /** 按日补同步续扫：IMAP UID 列表已扫描下标 */
  date_scan_offset?: number;
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
  degraded?: boolean;
  date_imap_total?: number;
  date_skipped_existing?: number;
  date_skipped_header?: number;
  date_scan_offset?: number;
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
  /** 部分阶段已转入后台队列，非硬失败 */
  degraded?: boolean;
  /** 按日补同步：该日仍未处理完的约剩封数 */
  dateRemaining?: number;
};

const DEFAULT_MAX_ROUNDS = 50;
const DEFAULT_MAX_BATCHES = 10;
/** 按日补同步可能上百封，需更多 HTTP 批次（每批仅处理少量 UID） */
const DEFAULT_DATE_SYNC_MAX_BATCHES = 120;
const DEFAULT_ROUND_DELAY_MS = 1500;
const DEFAULT_BATCH_DELAY_MS = 20_000;
const DEFAULT_WORKER_CANCEL_RETRY_DELAY_MS = 8000;
/** 补正文/补附件连续多轮无进展则结束，避免空转（如 IMAP 找不到 UID） */
const REPAIR_PHASE_STALL_ROUNDS = 2;

export function getSyncPhaseLabel(phase: SyncMailboxPhase): string {
  switch (phase) {
    case "incremental":
      return "增量";
    case "historical":
      return "历史";
    case "repair_body":
      return "补正文";
    case "repair_attachments":
      return "补附件";
  }
}

export function formatSyncPhaseProgress(phase: SyncMailboxPhase, p: PhasedSyncProgress): string {
  if (phase === "repair_body") {
    return `已补 ${p.repaired ?? 0} 封，仍剩空正文约 ${p.emptyBodyRemaining ?? p.remaining} 封`;
  }
  if (phase === "repair_attachments") {
    return `已补附件 ${p.repaired ?? 0} 封，仍剩占位约 ${p.remaining} 封`;
  }
  return `新增 ${p.inserted} 封，剩余 ${p.remaining} 封`;
}

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

export async function invokeSyncMailboxDate(
  mailboxId: string,
  syncOnDate: string,
  syncFromEmail?: string,
  dateScanOffset?: number,
): Promise<{ row: SyncMailboxResultRow | null; errorMessage?: string; degraded?: boolean }> {
  const body: SyncMailboxInvokeBody = { mailbox_id: mailboxId, sync_on_date: syncOnDate };
  const from = syncFromEmail?.trim();
  if (from) body.sync_from_email = from;
  if (typeof dateScanOffset === "number" && Number.isFinite(dateScanOffset) && dateScanOffset > 0) {
    body.date_scan_offset = Math.floor(dateScanOffset);
  }
  const { data, error } = await supabase.functions.invoke("sync-mailbox", { body });
  if (error) {
    const detail = await formatFunctionsInvokeError(error);
    return { row: null, errorMessage: detail };
  }
  if (data?.error && typeof data.error === "string") {
    return { row: null, errorMessage: data.error };
  }
  const row = (data?.results?.[0] ?? data) as SyncMailboxResultRow;
  if (row?.error) {
    return { row: null, errorMessage: row.error };
  }
  if (data?.degraded && data?.message) {
    return {
      row: { ...row, degraded: true, queued: true, queue_reason: data.message },
      degraded: true,
    };
  }
  return { row, degraded: Boolean(row?.degraded) };
}

/** 近 30 天内可选日期的 YYYY-MM-DD（本地日历） */
export function getDateResyncBounds(): { min: string; max: string } {
  const max = new Date();
  const min = new Date();
  min.setDate(min.getDate() - 30);
  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  return { min: fmt(min), max: fmt(max) };
}

export type RunDateMailboxSyncOptions = {
  mailboxId: string;
  syncOnDate: string;
  syncFromEmail?: string;
  maxBatches?: number;
  roundDelayMs?: number;
  onProgress?: (p: { batch: number; inserted: number; remaining: number }) => void;
  wait?: (ms: number) => Promise<void>;
};

/** 按指定日期补同步（可多批直到该日邮件处理完或达批次数上限） */
export async function runDateMailboxSync(
  options: RunDateMailboxSyncOptions,
): Promise<PhasedSyncOutcome> {
  const {
    mailboxId,
    syncOnDate,
    syncFromEmail,
    maxBatches = DEFAULT_DATE_SYNC_MAX_BATCHES,
    roundDelayMs = DEFAULT_ROUND_DELAY_MS,
    onProgress,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  let totalInserted = 0;
  let failed = false;
  let errorMessage: string | undefined;
  let degraded = false;
  let remaining = 1;
  let scanOffset = 0;
  let lastRemaining = -1;
  let stallBatches = 0;
  let workerCancelRetries = 0;

  for (let batch = 1; batch <= maxBatches && remaining > 0; batch++) {
    const { row, errorMessage: invokeErr, degraded: invokeDegraded } = await invokeSyncMailboxDate(
      mailboxId,
      syncOnDate,
      syncFromEmail,
      scanOffset,
    );
    if (invokeErr) {
      if (
        workerCancelRetries < 3 &&
        (isWorkerRequestCancelledError(invokeErr) || shouldEnqueueAttachmentRepairOnFailure(invokeErr))
      ) {
        workerCancelRetries++;
        degraded = true;
        batch--;
        await wait(DEFAULT_WORKER_CANCEL_RETRY_DELAY_MS);
        continue;
      }
      if (totalInserted > 0) {
        degraded = true;
        errorMessage = invokeErr;
        break;
      }
      failed = true;
      errorMessage = invokeErr;
      break;
    }
    workerCancelRetries = 0;
    if (invokeDegraded) degraded = true;
    const inserted = row?.inserted ?? 0;
    remaining = row?.remaining ?? 0;
    if (typeof row?.date_scan_offset === "number" && Number.isFinite(row.date_scan_offset)) {
      scanOffset = Math.max(0, Math.floor(row.date_scan_offset));
    }
    totalInserted += inserted;
    onProgress?.({ batch, inserted, remaining });
    if (remaining === lastRemaining && inserted === 0) {
      stallBatches++;
      if (stallBatches >= 3) {
        failed = true;
        errorMessage = "按日补同步进度停滞，请稍后重试或检查发件人筛选";
        break;
      }
    } else {
      stallBatches = 0;
    }
    lastRemaining = remaining;
    if (remaining > 0 && batch < maxBatches) await wait(roundDelayMs);
  }

  return {
    totalInserted,
    historyRemaining: 0,
    emptyBodyRemaining: 0,
    totalRepaired: 0,
    failed,
    errorMessage,
    degraded,
    dateRemaining: remaining,
  };
}

export async function invokeSyncMailboxPhase(
  mailboxId: string,
  phase: SyncMailboxPhase,
): Promise<{ row: SyncMailboxResultRow | null; errorMessage?: string; degraded?: boolean }> {
  const { data, error } = await supabase.functions.invoke("sync-mailbox", {
    body: buildInvokeBody(mailboxId, phase),
  });
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
  if (data?.degraded && data?.message) {
    const row = (data?.results?.[0] ?? {
      inserted: 0,
      remaining: 0,
      queued: true,
      degraded: true,
      queue_reason: String(data.message),
    }) as SyncMailboxResultRow;
    return { row, degraded: true };
  }
  if (data?.error) {
    return { row: null, errorMessage: String(data.error) };
  }
  const row = (data?.results?.[0] ?? null) as SyncMailboxResultRow | null;
  if (row?.degraded || row?.queued) {
    return { row, degraded: true };
  }
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
  let degraded = false;

  const phases: SyncMailboxPhase[] = ["incremental", "historical", "repair_body", "repair_attachments"];

  for (const phase of phases) {
    if (failed) break;
    let workerCancelRetries = 0;
    let repairStallRounds = 0;
    let lastRepairRemain: number | undefined;

    for (let batch = 1; batch <= maxBatches; batch++) {
      let rounds = 0;
      let phaseDone = false;

      while (rounds < maxRoundsPerPhase) {
        rounds++;
        const { row, errorMessage: invokeErr, degraded: invokeDegraded } = await invokeSyncMailboxPhase(
          mailboxId,
          phase,
        );
        if (invokeErr) {
          if (
            workerCancelRetries < 2 &&
            shouldEnqueueAttachmentRepairOnFailure(invokeErr)
          ) {
            workerCancelRetries++;
            rounds--;
            await wait(workerCancelRetryDelayMs);
            continue;
          }
          if (
            (phase === "repair_body" || phase === "repair_attachments") &&
            shouldEnqueueAttachmentRepairOnFailure(invokeErr)
          ) {
            degraded = true;
            phaseDone = true;
            break;
          }
          failed = true;
          errorMessage = invokeErr;
          phaseDone = true;
          break;
        }
        if (invokeDegraded) {
          degraded = true;
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
          if (emptyRemain === 0) {
            phaseDone = true;
            break;
          }
          if (repaired > 0) {
            repairStallRounds = 0;
          } else if (lastRepairRemain === emptyRemain) {
            repairStallRounds++;
          } else {
            repairStallRounds = 1;
          }
          lastRepairRemain = emptyRemain;
          if (repairStallRounds >= REPAIR_PHASE_STALL_ROUNDS) {
            phaseDone = true;
            break;
          }
        } else {
          const attRemain = remaining;
          if (attRemain === 0) {
            phaseDone = true;
            break;
          }
          if (repaired > 0) {
            repairStallRounds = 0;
          } else if (lastRepairRemain === attRemain) {
            repairStallRounds++;
          } else {
            repairStallRounds = 1;
          }
          lastRepairRemain = attRemain;
          if (repairStallRounds >= REPAIR_PHASE_STALL_ROUNDS) {
            phaseDone = true;
            break;
          }
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
    degraded,
  };
}
