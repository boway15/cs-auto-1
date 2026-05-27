import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    functions: {
      invoke: vi.fn(),
    },
  },
}));

import { supabase } from "@/lib/supabase";
import {
  enqueueAttachmentRepairForEmail,
  invokeRepairSingleEmail,
  invokeRepairSingleEmailWithRetry,
  invokeSyncMailboxPhase,
  runPhasedMailboxSync,
} from "@/lib/sync-mailbox-phased";

describe("invokeSyncMailboxPhase", () => {
  beforeEach(() => {
    vi.mocked(supabase.functions.invoke).mockReset();
  });

  it("增量阶段不传 force_bulk / repair_empty_body", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: { results: [{ inserted: 0, remaining: 0 }] },
      error: null,
    } as never);

    await invokeSyncMailboxPhase("mb-1", "incremental");
    expect(supabase.functions.invoke).toHaveBeenCalledWith("sync-mailbox", {
      body: { mailbox_id: "mb-1" },
    });
  });

  it("历史阶段传 force_bulk", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: { results: [{ inserted: 2, remaining: 10 }] },
      error: null,
    } as never);

    await invokeSyncMailboxPhase("mb-1", "historical");
    expect(supabase.functions.invoke).toHaveBeenCalledWith("sync-mailbox", {
      body: { mailbox_id: "mb-1", force_bulk: true },
    });
  });

  it("补正文阶段传 repair_empty_body", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: { results: [{ repaired: 3, empty_body_remaining: 7, remaining: 7 }] },
      error: null,
    } as never);

    await invokeSyncMailboxPhase("mb-1", "repair_body");
    expect(supabase.functions.invoke).toHaveBeenCalledWith("sync-mailbox", {
      body: { mailbox_id: "mb-1", repair_empty_body: true },
    });
  });

  it("补附件阶段传 repair_missing_attachments", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: { results: [{ repaired: 1, remaining: 4 }] },
      error: null,
    } as never);

    await invokeSyncMailboxPhase("mb-1", "repair_attachments");
    expect(supabase.functions.invoke).toHaveBeenCalledWith("sync-mailbox", {
      body: { mailbox_id: "mb-1", repair_missing_attachments: true },
    });
  });

  it("单封补拉传 repair_email_id", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: { results: [{ repaired: 1, mode: "repair_single" }] },
      error: null,
    } as never);

    await invokeRepairSingleEmail("email-1");
    expect(supabase.functions.invoke).toHaveBeenCalledWith("sync-mailbox", {
      body: { repair_email_id: "email-1" },
    });
  });

  it("附件补拉可入后台队列", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: { queued: true, task_id: "task-1" },
      error: null,
    } as never);

    const result = await enqueueAttachmentRepairForEmail("email-queue");
    expect(result.queued).toBe(true);
    expect(result.taskId).toBe("task-1");
    expect(supabase.functions.invoke).toHaveBeenCalledWith("sync-mailbox", {
      body: { repair_email_id: "email-queue", queue_attachment_repair: true },
    });
  });

  it("单封补拉遇到 WorkerRequestCancelled 会重试", async () => {
    vi.mocked(supabase.functions.invoke)
      .mockResolvedValueOnce({
        data: null,
        error: { message: "WorkerRequestCancelled: request has been cancelled by supervisor" },
      } as never)
      .mockResolvedValueOnce({
        data: { results: [{ repaired: 1, mode: "repair_single" }] },
        error: null,
      } as never);

    const result = await invokeRepairSingleEmailWithRetry({
      emailId: "email-2",
      maxRetries: 2,
      retryDelayMs: 0,
      wait: async () => {},
    });

    expect(result.errorMessage).toBeUndefined();
    expect(result.retries).toBe(1);
    expect(result.row?.repaired).toBe(1);
    expect(supabase.functions.invoke).toHaveBeenCalledTimes(2);
  });

  it("单封补拉超过重试上限仍失败", async () => {
    vi.mocked(supabase.functions.invoke)
      .mockResolvedValueOnce({
        data: null,
        error: { message: "WorkerRequestCancelled: request has been cancelled by supervisor" },
      } as never)
      .mockResolvedValueOnce({
        data: null,
        error: { message: "WorkerRequestCancelled: request has been cancelled by supervisor" },
      } as never)
      .mockResolvedValueOnce({
        data: null,
        error: { message: "WorkerRequestCancelled: request has been cancelled by supervisor" },
      } as never);

    const result = await invokeRepairSingleEmailWithRetry({
      emailId: "email-3",
      maxRetries: 2,
      retryDelayMs: 0,
      wait: async () => {},
    });

    expect(result.errorMessage).toMatch(/WorkerRequestCancelled/i);
    expect(result.retries).toBe(2);
    expect(result.row).toBeNull();
    expect(supabase.functions.invoke).toHaveBeenCalledTimes(3);
  });
});

describe("runPhasedMailboxSync", () => {
  beforeEach(() => {
    vi.mocked(supabase.functions.invoke).mockReset();
  });

  it("四阶段均成功时汇总 inserted 与 repaired", async () => {
    vi.mocked(supabase.functions.invoke)
      .mockResolvedValueOnce({
        data: { results: [{ inserted: 1, remaining: 0 }] },
        error: null,
      } as never)
      .mockResolvedValueOnce({
        data: { results: [{ inserted: 0, remaining: 0 }] },
        error: null,
      } as never)
      .mockResolvedValueOnce({
        data: { results: [{ repaired: 2, empty_body_remaining: 0, remaining: 0 }] },
        error: null,
      } as never)
      .mockResolvedValueOnce({
        data: { results: [{ repaired: 1, remaining: 0 }] },
        error: null,
      } as never);

    const outcome = await runPhasedMailboxSync({
      mailboxId: "mb-1",
      maxBatches: 1,
      maxRoundsPerPhase: 1,
      roundDelayMs: 0,
      batchDelayMs: 0,
      wait: async () => {},
    });

    expect(outcome.failed).toBe(false);
    expect(outcome.totalInserted).toBe(1);
    expect(outcome.totalRepaired).toBe(3);
    expect(outcome.emptyBodyRemaining).toBe(0);
  });
});
