import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { actorUserIdOrNull } from "./actor-user-id.ts";

const validUuid = "16a521a7-ff0d-48e0-9f0f-bb2a72ec0b83";

Deno.test("actorUserIdOrNull returns null for service role", () => {
  assertEquals(actorUserIdOrNull({ userId: "", isService: true }), null);
});

Deno.test("actorUserIdOrNull returns null for empty userId", () => {
  assertEquals(actorUserIdOrNull({ userId: "" }), null);
  assertEquals(actorUserIdOrNull({ userId: "   " }), null);
});

Deno.test("actorUserIdOrNull returns uuid for authenticated staff", () => {
  assertEquals(actorUserIdOrNull({ userId: validUuid }), validUuid);
});
