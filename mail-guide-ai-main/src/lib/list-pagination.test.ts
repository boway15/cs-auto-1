import { describe, expect, it } from "vitest";
import {
  clampListPageAfterLoad,
  parseListPageJumpInput,
  shouldClampListPage,
} from "./list-pagination";

describe("parseListPageJumpInput", () => {
  it("解析 1-based 页码并钳制到有效范围", () => {
    expect(parseListPageJumpInput("3", 5)).toBe(2);
    expect(parseListPageJumpInput("99", 5)).toBe(4);
    expect(parseListPageJumpInput("0", 5)).toBeNull();
    expect(parseListPageJumpInput("abc", 5)).toBeNull();
  });
});

describe("shouldClampListPage", () => {
  it("加载中不因 total 暂为 0 钳制页码", () => {
    expect(shouldClampListPage(1, 1, true)).toBe(false);
  });

  it("加载完成后超出末页时钳制", () => {
    expect(shouldClampListPage(2, 2, false)).toBe(true);
    expect(clampListPageAfterLoad(2, 2, false)).toBe(1);
  });
});
