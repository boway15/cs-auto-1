import { describe, expect, it } from "vitest";

import { shouldRefetchAccessForAuthEvent } from "./useAuth";

describe("shouldRefetchAccessForAuthEvent", () => {
  it("同一用户 token 刷新时不重新拉角色授权", () => {
    expect(shouldRefetchAccessForAuthEvent("TOKEN_REFRESHED", "user-1", "user-1")).toBe(false);
  });

  it("同一用户重新聚焦触发 SIGNED_IN 时不重新拉角色授权", () => {
    expect(shouldRefetchAccessForAuthEvent("SIGNED_IN", "user-1", "user-1")).toBe(false);
  });

  it("首次拿到用户或用户变化时重新拉角色授权", () => {
    expect(shouldRefetchAccessForAuthEvent("INITIAL_SESSION", null, "user-1")).toBe(true);
    expect(shouldRefetchAccessForAuthEvent("TOKEN_REFRESHED", "user-1", "user-2")).toBe(true);
    expect(shouldRefetchAccessForAuthEvent("SIGNED_IN", "user-1", "user-2")).toBe(true);
  });

  it("无用户时不拉角色授权", () => {
    expect(shouldRefetchAccessForAuthEvent("SIGNED_OUT", "user-1", null)).toBe(false);
  });
});
