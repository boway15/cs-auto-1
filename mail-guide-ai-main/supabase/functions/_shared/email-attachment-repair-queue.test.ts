import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  attachmentsJsonHasValidStoragePath,
  classifyAttachmentRepairFailure,
  nextAttachmentPartialResumeIso,
  nextAttachmentRepairBackoffIso,
} from "./email-attachment-repair-queue.ts";

Deno.test("attachmentsJsonHasValidStoragePath rejects placeholder count/note", () => {
  assertEquals(
    attachmentsJsonHasValidStoragePath([{
      count: 3,
      note: "邮件体积较大，已转入后台队列拉取正文与附件，请稍后刷新。",
    }]),
    false,
  );
});

Deno.test("attachmentsJsonHasValidStoragePath accepts storage_path", () => {
  assertEquals(
    attachmentsJsonHasValidStoragePath([{
      filename: "IMG_6406.jpeg",
      contentType: "image/jpeg",
      size: 1304100,
      storage_path: "mb/email/0_IMG_6406.jpeg",
    }]),
    true,
  );
});

Deno.test("attachmentsJsonHasValidStoragePath rejects zero size", () => {
  assertEquals(
    attachmentsJsonHasValidStoragePath([{
      filename: "a.bin",
      storage_path: "mb/email/0_a.bin",
      size: 0,
    }]),
    false,
  );
});

Deno.test("classifyAttachmentRepairFailure maps WorkerRequestCancelled", () => {
  const r = classifyAttachmentRepairFailure(
    '{"msg":"WorkerRequestCancelled: request has been cancelled by supervisor"}',
    1,
    6,
  );
  assertEquals(r.terminal, false);
  assertEquals(r.lastError.includes("资源限制") || r.lastError.includes("超时"), true);
});

Deno.test("nextAttachmentRepairBackoffIso uses longer delay for CPU cancel", () => {
  const normal = Date.parse(nextAttachmentRepairBackoffIso(1, "something else"));
  const cancelled = Date.parse(
    nextAttachmentRepairBackoffIso(1, "CPU time hard limit reached"),
  );
  // 取消退避至少约 30min，普通约 10min
  assertEquals(cancelled - Date.now() > 25 * 60 * 1000, true);
  assertEquals(normal - Date.now() > 8 * 60 * 1000, true);
  assertEquals(cancelled > normal, true);
});

Deno.test("nextAttachmentPartialResumeIso is soon", () => {
  const t = Date.parse(nextAttachmentPartialResumeIso()) - Date.now();
  assertEquals(t > 10_000 && t < 120_000, true);
});
