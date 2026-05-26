import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    functions: {
      invoke: vi.fn(),
    },
  },
}));

import { supabase } from "@/lib/supabase";
import { invokeSyncMailboxPhase, runPhasedMailboxSync } from "@/lib/sync-mailbox-phased";

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
});

describe("runPhasedMailboxSync", () => {
  beforeEach(() => {
    vi.mocked(supabase.functions.invoke).mockReset();
  });

  it("三阶段均成功时汇总 inserted 与 repaired", async () => {
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
    expect(outcome.totalRepaired).toBe(2);
    expect(outcome.emptyBodyRemaining).toBe(0);
  });
});
