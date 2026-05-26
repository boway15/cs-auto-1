import { describe, expect, it } from "vitest";
import {
  deriveBodyRepairUiStatusFromTask,
  formatBodyRepairTaskHint,
  mapSyncRepairRow,
} from "@/lib/email-body";

describe("mapSyncRepairRow", () => {
  it("queued 时返回已入队", () => {
    expect(mapSyncRepairRow({ queued: true, queue_reason: "timeout" })).toEqual({
      ok: true,
      repaired: false,
      queued: true,
      queueReason: "timeout",
    });
  });

  it("terminal 错误不入队", () => {
    expect(
      mapSyncRepairRow({ error: "人工解除关联", terminal: true }),
    ).toEqual({
      ok: false,
      errorMessage: "人工解除关联",
      terminal: true,
    });
  });

  it("skip_no_uid 入队由后端 queued 标志表达", () => {
    expect(
      mapSyncRepairRow({ queued: true, queue_reason: "skip_no_uid_imap_search_miss" }),
    ).toMatchObject({ ok: true, queued: true });
  });
});

describe("deriveBodyRepairUiStatusFromTask", () => {
  it("pending + uid not found -> not_found_retrying", () => {
    expect(
      deriveBodyRepairUiStatusFromTask({
        status: "pending",
        last_error: "skip_no_uid_imap_search_miss",
      }),
    ).toBe("not_found_retrying");
  });

  it("failed -> failed_terminal", () => {
    expect(
      deriveBodyRepairUiStatusFromTask({ status: "failed", last_error: "x" }),
    ).toBe("failed_terminal");
  });
});

describe("formatBodyRepairTaskHint", () => {
  it("包含重试次数", () => {
    const hint = formatBodyRepairTaskHint({
      status: "pending",
      attempt_count: 2,
      next_run_at: new Date(Date.now() + 60000).toISOString(),
    });
    expect(hint).toContain("第 2 次尝试");
  });
});
