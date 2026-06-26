import {
  clampWorkbenchDateRange,
  defaultWorkbenchListDateFrom,
  defaultWorkbenchListDateTo,
  type WorkbenchListStatusFilter,
} from "@/lib/workbench-email-list";
import type { SlaBucket } from "@/lib/customerService";

const WORKBENCH_VIEW_PARAMS = [
  "from",
  "to",
  "status",
  "mailbox",
  "intent",
  "association",
  "sla",
  "q",
  "page",
  "email",
  "filters",
] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_VALUES = new Set<WorkbenchListStatusFilter>(["all", "pending", "auto_replied", "replied"]);
const SLA_VALUES = new Set<"all" | SlaBucket>(["all", "within_24h", "within_48h", "within_72h", "over_72h"]);

export type WorkbenchViewState = {
  dateFrom: string;
  dateTo: string;
  status: WorkbenchListStatusFilter;
  mailbox: string;
  intent: string;
  association: string;
  sla: "all" | SlaBucket;
  search: string;
  page: number;
  email: string | null;
  filtersCollapsed: boolean;
};

type RawWorkbenchViewState = Partial<{
  dateFrom: unknown;
  dateTo: unknown;
  status: unknown;
  mailbox: unknown;
  intent: unknown;
  association: unknown;
  sla: unknown;
  search: unknown;
  page: unknown;
  email: unknown;
  filtersCollapsed: unknown;
}>;

export type WorkbenchQueryState = Pick<
  WorkbenchViewState,
  "dateFrom" | "dateTo" | "status" | "mailbox" | "intent" | "association" | "sla" | "search" | "page"
>;

export function defaultWorkbenchViewState(): WorkbenchViewState {
  const range = clampWorkbenchDateRange(defaultWorkbenchListDateFrom(), defaultWorkbenchListDateTo());
  return {
    ...defaultWorkbenchQueryState(range.dateFrom, range.dateTo),
    email: null,
    filtersCollapsed: true,
  };
}

export function defaultWorkbenchQueryState(
  dateFrom?: string,
  dateTo?: string,
): WorkbenchQueryState {
  const range = clampWorkbenchDateRange(
    dateFrom ?? defaultWorkbenchListDateFrom(),
    dateTo ?? defaultWorkbenchListDateTo(),
  );
  return {
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    status: "all",
    mailbox: "all",
    intent: "all",
    association: "all",
    sla: "all",
    search: "",
    page: 0,
  };
}

export function isDefaultWorkbenchQueryState(state: WorkbenchQueryState): boolean {
  const defaults = defaultWorkbenchQueryState();
  return (
    state.dateFrom === defaults.dateFrom
    && state.dateTo === defaults.dateTo
    && state.status === defaults.status
    && state.mailbox === defaults.mailbox
    && state.intent === defaults.intent
    && state.association === defaults.association
    && state.sla === defaults.sla
    && state.search === defaults.search
    && state.page === defaults.page
  );
}

export function hasWorkbenchViewParams(params: URLSearchParams): boolean {
  return WORKBENCH_VIEW_PARAMS.some((name) => params.has(name));
}

/** 仅当 URL 带工作台参数时恢复；否则回默认（菜单切回工作台不带历史筛选） */
export function parseWorkbenchViewState(search: string): WorkbenchViewState {
  const params = new URLSearchParams(search);
  if (!hasWorkbenchViewParams(params)) {
    return defaultWorkbenchViewState();
  }

  return normalizeWorkbenchViewState({
    dateFrom: params.get("from"),
    dateTo: params.get("to"),
    status: params.get("status"),
    mailbox: params.get("mailbox"),
    intent: params.get("intent"),
    association: params.get("association"),
    sla: params.get("sla"),
    search: params.get("q"),
    page: params.get("page"),
    email: params.get("email"),
    filtersCollapsed: params.get("filters"),
  });
}

export function readInitialWorkbenchViewState(
  search: string = typeof window !== "undefined" ? window.location.search : "",
): WorkbenchViewState {
  return parseWorkbenchViewState(search);
}

export function serializeWorkbenchViewStateToParams(
  currentParams: URLSearchParams,
  state: WorkbenchViewState,
): URLSearchParams {
  const next = new URLSearchParams(currentParams);

  next.set("from", state.dateFrom);
  next.set("to", state.dateTo);
  setOrDelete(next, "status", state.status, "all");
  setOrDelete(next, "mailbox", state.mailbox, "all");
  setOrDelete(next, "intent", state.intent, "all");
  setOrDelete(next, "association", state.association, "all");
  setOrDelete(next, "sla", state.sla, "all");
  setOrDelete(next, "q", state.search, "");
  setOrDelete(next, "page", String(state.page), "0");
  if (state.email) next.set("email", state.email);
  else next.delete("email");
  setOrDelete(next, "filters", state.filtersCollapsed ? "1" : "0", "1");

  return next;
}

/** 离开工作台路由时清除 URL 上的工作台查询参数，避免菜单回到 `/` 仍带筛选 */
export function clearWorkbenchViewParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const name of WORKBENCH_VIEW_PARAMS) {
    next.delete(name);
  }
  return next;
}

function normalizeWorkbenchViewState(raw: RawWorkbenchViewState | null | undefined): WorkbenchViewState {
  const defaults = defaultWorkbenchViewState();
  const from = readDate(raw?.dateFrom, defaults.dateFrom);
  const to = readDate(raw?.dateTo, defaults.dateTo);
  const range = clampWorkbenchDateRange(from, to);

  return {
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    status: readStatus(raw?.status),
    mailbox: readNonEmpty(raw?.mailbox, "all"),
    intent: readNonEmpty(raw?.intent, "all"),
    association: readNonEmpty(raw?.association, "all"),
    sla: readSla(raw?.sla),
    search: typeof raw?.search === "string" ? raw.search : "",
    page: readPage(raw?.page),
    email: readEmail(raw?.email),
    filtersCollapsed: readFiltersCollapsed(raw?.filtersCollapsed),
  };
}

function readDate(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return fallback;
  return Number.isNaN(new Date(`${value}T12:00:00+08:00`).getTime()) ? fallback : value;
}

function readStatus(value: unknown): WorkbenchListStatusFilter {
  return typeof value === "string" && STATUS_VALUES.has(value as WorkbenchListStatusFilter)
    ? (value as WorkbenchListStatusFilter)
    : "all";
}

function readSla(value: unknown): "all" | SlaBucket {
  return typeof value === "string" && SLA_VALUES.has(value as "all" | SlaBucket)
    ? (value as "all" | SlaBucket)
    : "all";
}

function readNonEmpty(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function readPage(value: unknown): number {
  const page = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(page) && page >= 0 ? page : 0;
}

function readEmail(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

function readFiltersCollapsed(value: unknown): boolean {
  if (value === false || value === "0" || value === "false") return false;
  return true;
}

function setOrDelete(params: URLSearchParams, key: string, value: string, defaultValue: string): void {
  if (value === defaultValue) params.delete(key);
  else params.set(key, value);
}

/** 工作台邮件列表滚动位置（同标签页内菜单切换后恢复） */
export const WORKBENCH_LIST_SCROLL_SESSION_KEY = "mail-guide-ai:workbench-list-scroll:v1";
export const WORKBENCH_LIST_ANCHOR_SESSION_KEY = "mail-guide-ai:workbench-list-anchor:v1";

export type WorkbenchListScrollAnchor = {
  emailId: string;
  offsetTop: number;
};

export function getWorkbenchListScrollViewport(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  return root.querySelector("[data-radix-scroll-area-viewport]");
}

export function readWorkbenchListScrollTop(): number | null {
  try {
    const raw = window.sessionStorage.getItem(WORKBENCH_LIST_SCROLL_SESSION_KEY);
    if (raw == null) return null;
    const top = Number.parseInt(raw, 10);
    return Number.isFinite(top) && top >= 0 ? top : null;
  } catch {
    return null;
  }
}

export function writeWorkbenchListScrollTop(scrollTop: number): void {
  if (!Number.isFinite(scrollTop) || scrollTop < 0) return;
  try {
    window.sessionStorage.setItem(WORKBENCH_LIST_SCROLL_SESSION_KEY, String(Math.round(scrollTop)));
  } catch {
    // sessionStorage 不可用时忽略
  }
}

export function clearWorkbenchListScrollTop(): void {
  try {
    window.sessionStorage.removeItem(WORKBENCH_LIST_SCROLL_SESSION_KEY);
    window.sessionStorage.removeItem(WORKBENCH_LIST_ANCHOR_SESSION_KEY);
  } catch {
    // ignore
  }
}

export function readWorkbenchListScrollAnchor(): WorkbenchListScrollAnchor | null {
  try {
    const raw = window.sessionStorage.getItem(WORKBENCH_LIST_ANCHOR_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WorkbenchListScrollAnchor>;
    if (typeof parsed.emailId !== "string" || !parsed.emailId) return null;
    if (typeof parsed.offsetTop !== "number" || !Number.isFinite(parsed.offsetTop)) return null;
    return { emailId: parsed.emailId, offsetTop: parsed.offsetTop };
  } catch {
    return null;
  }
}

export function writeWorkbenchListScrollAnchor(anchor: WorkbenchListScrollAnchor | null): void {
  try {
    if (!anchor) {
      window.sessionStorage.removeItem(WORKBENCH_LIST_ANCHOR_SESSION_KEY);
      return;
    }
    window.sessionStorage.setItem(WORKBENCH_LIST_ANCHOR_SESSION_KEY, JSON.stringify(anchor));
  } catch {
    // sessionStorage 不可用时忽略
  }
}
