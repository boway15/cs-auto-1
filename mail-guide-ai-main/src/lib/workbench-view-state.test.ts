import { describe, expect, it } from "vitest";
import {
  clearWorkbenchListScrollTop,
  clearWorkbenchViewParams,
  defaultWorkbenchQueryState,
  isDefaultWorkbenchQueryState,
  parseWorkbenchViewState,
  readWorkbenchListScrollAnchor,
  readWorkbenchListScrollTop,
  serializeWorkbenchViewStateToParams,
  writeWorkbenchListScrollAnchor,
  writeWorkbenchListScrollTop,
  WORKBENCH_LIST_ANCHOR_SESSION_KEY,
  WORKBENCH_LIST_SCROLL_SESSION_KEY,
} from "./workbench-view-state";

describe("workbench-view-state", () => {
  it("URL 参数优先于默认值", () => {
    const state = parseWorkbenchViewState(
      "?from=2026-06-25&to=2026-06-25&status=replied&mailbox=mailbox-from-url&q=url%20query&page=2",
    );

    expect(state.dateFrom).toBe("2026-06-25");
    expect(state.dateTo).toBe("2026-06-25");
    expect(state.status).toBe("replied");
    expect(state.mailbox).toBe("mailbox-from-url");
    expect(state.search).toBe("url query");
    expect(state.page).toBe(2);
  });

  it("URL 没有工作台参数时回退默认值", () => {
    const state = parseWorkbenchViewState("");
    const defaults = defaultWorkbenchQueryState();

    expect(state).toMatchObject({
      ...defaults,
      email: null,
      filtersCollapsed: true,
    });
  });

  it("无效值回退到安全默认值", () => {
    const state = parseWorkbenchViewState(
      "?from=bad&to=2026-06-24&status=bad&page=-1&sla=bad&intent=bad&association=bad",
    );

    expect(state.dateFrom).toBeTruthy();
    expect(state.dateTo).toBe("2026-06-24");
    expect(state.status).toBe("all");
    expect(state.page).toBe(0);
    expect(state.sla).toBe("all");
    expect(state.intent).toBe("all");
    expect(state.association).toBe("all");
  });

  it("序列化为可分享 URL 参数并保留未知参数", () => {
    const params = serializeWorkbenchViewStateToParams(
      new URLSearchParams("foo=bar"),
      {
        dateFrom: "2026-06-24",
        dateTo: "2026-06-24",
        status: "pending",
        mailbox: "all",
        intent: "all",
        association: "all",
        sla: "all",
        search: "",
        page: 0,
        email: null,
        filtersCollapsed: true,
      },
    );

    expect(params.get("foo")).toBe("bar");
    expect(params.get("from")).toBe("2026-06-24");
    expect(params.get("to")).toBe("2026-06-24");
    expect(params.get("status")).toBe("pending");
    expect(params.has("mailbox")).toBe(false);
    expect(params.has("q")).toBe(false);
  });

  it("清除工作台 URL 查询参数", () => {
    const params = clearWorkbenchViewParams(
      new URLSearchParams("from=2026-06-24&to=2026-06-24&status=pending&foo=bar"),
    );

    expect(params.get("foo")).toBe("bar");
    expect(params.has("from")).toBe(false);
    expect(params.has("to")).toBe(false);
    expect(params.has("status")).toBe(false);
  });

  it("识别默认查询条件与非默认查询条件", () => {
    const defaults = defaultWorkbenchQueryState();
    expect(isDefaultWorkbenchQueryState(defaults)).toBe(true);
    expect(isDefaultWorkbenchQueryState({ ...defaults, search: "abc" })).toBe(false);
    expect(isDefaultWorkbenchQueryState({ ...defaults, status: "pending" })).toBe(false);
    expect(isDefaultWorkbenchQueryState({ ...defaults, page: 2 })).toBe(false);
  });

  it("读写邮件列表滚动位置", () => {
    clearWorkbenchListScrollTop();
    expect(readWorkbenchListScrollTop()).toBeNull();
    writeWorkbenchListScrollTop(420);
    expect(readWorkbenchListScrollTop()).toBe(420);
    expect(sessionStorage.getItem(WORKBENCH_LIST_SCROLL_SESSION_KEY)).toBe("420");
    clearWorkbenchListScrollTop();
    expect(readWorkbenchListScrollTop()).toBeNull();
  });

  it("读写邮件列表滚动锚点", () => {
    clearWorkbenchListScrollTop();
    expect(readWorkbenchListScrollAnchor()).toBeNull();
    writeWorkbenchListScrollAnchor({ emailId: "email-1", offsetTop: 12 });
    expect(readWorkbenchListScrollAnchor()).toEqual({ emailId: "email-1", offsetTop: 12 });
    expect(sessionStorage.getItem(WORKBENCH_LIST_ANCHOR_SESSION_KEY)).toContain("email-1");
    clearWorkbenchListScrollTop();
    expect(readWorkbenchListScrollAnchor()).toBeNull();
  });
});
