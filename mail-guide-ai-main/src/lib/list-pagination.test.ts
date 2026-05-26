import { describe, expect, it } from "vitest";
import { parseListPageJumpInput } from "./list-pagination";

describe("parseListPageJumpInput", () => {
  it("解析 1-based 页码并钳制到有效范围", () => {
    expect(parseListPageJumpInput("3", 5)).toBe(2);
    expect(parseListPageJumpInput("99", 5)).toBe(4);
    expect(parseListPageJumpInput("0", 5)).toBeNull();
    expect(parseListPageJumpInput("abc", 5)).toBeNull();
  });
});
