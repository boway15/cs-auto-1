import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { emailHeaderWithinSlaWindow, parseSlaWindow } from "./sla-sync-window.ts";

Deno.test("parseSlaWindow rejects invalid hours", () => {
  assertEquals(parseSlaWindow(0).ok, false);
  assertEquals(parseSlaWindow(-1).ok, false);
  assertEquals(parseSlaWindow(169).ok, false);
});

Deno.test("parseSlaWindow computes rolling window", () => {
  const now = new Date("2026-05-30T12:00:00.000Z");
  const result = parseSlaWindow(12, { now, widenMinutes: 15 });
  if (!result.ok) throw new Error("expected ok");
  assertAlmostEquals(
    result.since.getTime(),
    now.getTime() - 12 * 3600 * 1000 - 15 * 60 * 1000,
    1,
  );
  assertEquals(result.before.getTime(), now.getTime());
  assertEquals(result.hours, 12);
});

Deno.test("emailHeaderWithinSlaWindow accepts half-open interval", () => {
  const since = new Date("2026-05-30T00:00:00.000Z");
  const before = new Date("2026-05-30T12:00:00.000Z");
  assertEquals(
    emailHeaderWithinSlaWindow("Fri, 30 May 2026 06:00:00 +0000", since, before),
    true,
  );
  assertEquals(
    emailHeaderWithinSlaWindow("Fri, 30 May 2026 12:00:00 +0000", since, before),
    false,
  );
  assertEquals(emailHeaderWithinSlaWindow(null, since, before), true);
  assertEquals(emailHeaderWithinSlaWindow("not-a-date", since, before), true);
});
