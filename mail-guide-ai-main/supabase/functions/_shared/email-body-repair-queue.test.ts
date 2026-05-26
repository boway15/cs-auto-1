import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildMessageIdSearchCandidates,
  isUidNotFoundRepairError,
  messageIdMatchesHeader,
  normalizeMessageIdForCompare,
} from "./imap-message-id.ts";
import {
  friendlyRepairError,
  isWorkerCancelledError,
  nextRepairBackoffIso,
} from "./email-body-repair-queue.ts";

Deno.test("normalizeMessageIdForCompare strips brackets and case", () => {
  const a = normalizeMessageIdForCompare("<ABC@mail.com>");
  const b = normalizeMessageIdForCompare("abc@mail.com");
  assertEquals(a, b);
});

Deno.test("messageIdMatchesHeader accepts outlook style ids", () => {
  const id = "<SN6PR05MB641466296010C750013DFC87940A2@SN6PR05MB6414.namprd05.prod.outlook.com>";
  assertEquals(messageIdMatchesHeader(id, "SN6PR05MB641466296010C750013DFC87940A2@SN6PR05MB6414.namprd05.prod.outlook.com"), true);
});

Deno.test("buildMessageIdSearchCandidates includes bracket variants", () => {
  const c = buildMessageIdSearchCandidates("abc@x.com");
  assertEquals(c.includes("abc@x.com"), true);
  assertEquals(c.includes("<abc@x.com>"), true);
});

Deno.test("isUidNotFoundRepairError", () => {
  assertEquals(isUidNotFoundRepairError("skip_no_uid_imap_search_miss"), true);
  assertEquals(isUidNotFoundRepairError("timeout"), false);
});

Deno.test("isWorkerCancelledError detects cancellation", () => {
  assertEquals(isWorkerCancelledError(new Error("WorkerRequestCancelled")), true);
});

Deno.test("friendlyRepairError maps cancellation", () => {
  const msg = friendlyRepairError(new Error("WorkerRequestCancelled"));
  assertEquals(msg.includes("后台补拉队列"), true);
});

Deno.test("nextRepairBackoffIso increases delay", () => {
  const t1 = new Date(nextRepairBackoffIso(1)).getTime();
  const t2 = new Date(nextRepairBackoffIso(2)).getTime();
  assertEquals(t2 > t1, true);
});
