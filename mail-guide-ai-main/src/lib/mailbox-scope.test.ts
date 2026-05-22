import { describe, expect, it } from "vitest";
import { needsMailboxGrants, visibleScopeLabel } from "./mailbox-scope";

describe("mailbox-scope", () => {
  it("visibleScopeLabel for admin", () => {
    expect(visibleScopeLabel(["admin"], 0)).toContain("全部邮箱");
  });

  it("visibleScopeLabel for agent without grants", () => {
    expect(visibleScopeLabel(["agent"], 0)).toContain("未分配");
  });

  it("visibleScopeLabel for agent with grants", () => {
    expect(visibleScopeLabel(["agent"], 2)).toContain("2");
  });

  it("needsMailboxGrants", () => {
    expect(needsMailboxGrants("leader")).toBe(true);
    expect(needsMailboxGrants("agent")).toBe(true);
    expect(needsMailboxGrants("admin")).toBe(false);
  });
});
