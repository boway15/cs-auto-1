import type { SupabaseClient } from "@supabase/supabase-js";
import type { SlaBucket } from "@/lib/customerService";
import { cstDateStrDaysAgo, cstDayEndIso, cstDayStartIso, cstTodayDateStr } from "@/lib/format-datetime";

/** 工作台列表每页条数（日收 1000–2000 封时避免一次拉全表） */
export const WORKBENCH_LIST_PAGE_SIZE = 50;

/** 列表默认查询近 N 天；单次区间上限（含首尾） */
export const WORKBENCH_LIST_DEFAULT_DATE_RANGE_DAYS = 30;
export const WORKBENCH_LIST_MAX_DATE_RANGE_DAYS = 120;

export type WorkbenchListStatusFilter = "all" | "pending" | "auto_replied" | "replied";

export function workbenchDateStrToAnchor(dateStr: string): Date {
  return new Date(`${dateStr}T12:00:00+08:00`);
}

export function workbenchDaysBetweenDateStrs(from: string, to: string): number {
  const a = workbenchDateStrToAnchor(from).getTime();
  const b = workbenchDateStrToAnchor(to).getTime();
  return Math.round(Math.abs(b - a) / 86_400_000);
}

/** 归一化区间：起止有序、跨度不超过 maxDays（超出则保留结束日、前移开始日） */
export function clampWorkbenchDateRange(
  dateFrom: string,
  dateTo: string,
  maxDays: number = WORKBENCH_LIST_MAX_DATE_RANGE_DAYS,
): { dateFrom: string; dateTo: string } {
  let from = dateFrom || cstDateStrDaysAgo(WORKBENCH_LIST_DEFAULT_DATE_RANGE_DAYS);
  let to = dateTo || cstTodayDateStr();
  if (from > to) {
    const tmp = from;
    from = to;
    to = tmp;
  }
  if (workbenchDaysBetweenDateStrs(from, to) > maxDays) {
    from = cstDateStrDaysAgo(maxDays, workbenchDateStrToAnchor(to));
  }
  return { dateFrom: from, dateTo: to };
}

export function defaultWorkbenchListDateFrom(): string {
  return cstDateStrDaysAgo(WORKBENCH_LIST_DEFAULT_DATE_RANGE_DAYS);
}

export function defaultWorkbenchListDateTo(): string {
  return cstTodayDateStr();
}

export function workbenchListDateRangeLabel(dateFrom: string, dateTo: string): string {
  if (dateFrom && dateTo) return `${dateFrom} ~ ${dateTo}`;
  if (dateFrom) return `${dateFrom} 起`;
  if (dateTo) return `至 ${dateTo}`;
  return "全部历史";
}

/** 列表用字段（不含正文/HTML，详情在 loadDetail 再拉 *） */
export const WORKBENCH_EMAIL_LIST_SELECT =
  "id, message_id, from_email, from_name, to_email, subject, ai_summary, received_at, status, is_read, mailbox_id, category, business_intent, association_status, processing_status, missing_elements, ai_entities, intent_legacy, priority, risk_level, sla_bucket, attachments";

export type WorkbenchListFilters = {
  dateFrom: string;
  dateTo: string;
  status: WorkbenchListStatusFilter;
  mailboxId: string;
  mailboxToEmail: string | null;
  association: string;
  intent: string;
  slaBucket: "all" | SlaBucket;
  search: string;
};

/** SLA 时间桶 → received_at 区间（与 computeSlaBucket 口径一致） */
export function slaReceivedAtBounds(
  bucket: SlaBucket,
): { gte?: string; lt?: string; lte?: string } {
  const now = Date.now();
  const h = (n: number) => new Date(now - n * 3_600_000).toISOString();
  switch (bucket) {
    case "within_24h":
      return { gte: h(24) };
    case "within_48h":
      return { gte: h(48), lt: h(24) };
    case "within_72h":
      return { gte: h(72), lt: h(48) };
    case "over_72h":
      return { lt: h(72) };
  }
}

function escapeIlike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function postgrestQuoted(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyWorkbenchListFilters(query: any, filters: WorkbenchListFilters): any {
  let q = query;
  const { dateFrom, dateTo } = clampWorkbenchDateRange(filters.dateFrom, filters.dateTo);
  q = q.gte("received_at", cstDayStartIso(dateFrom));
  q = q.lte("received_at", cstDayEndIso(dateTo));

  if (filters.status === "pending") {
    q = q.in("status", ["pending", "processing"]);
  } else if (filters.status === "auto_replied") {
    q = q.eq("status", "replied").eq("processing_status", "auto_replied");
  } else if (filters.status === "replied") {
    q = q.eq("status", "replied").neq("processing_status", "auto_replied");
  }

  if (filters.mailboxId !== "all") {
    if (filters.mailboxToEmail) {
      q = q.or(
        `mailbox_id.eq.${filters.mailboxId},to_email.eq.${postgrestQuoted(filters.mailboxToEmail)}`,
      );
    } else {
      q = q.eq("mailbox_id", filters.mailboxId);
    }
  }
  if (filters.intent !== "all") {
    q = q.eq("business_intent", filters.intent);
  }
  if (filters.association !== "all") {
    q = q.eq("association_status", filters.association);
  }
  if (filters.slaBucket !== "all") {
    const b = slaReceivedAtBounds(filters.slaBucket);
    if (b.gte) q = q.gte("received_at", b.gte);
    if (b.lt) q = q.lt("received_at", b.lt);
    if (b.lte) q = q.lte("received_at", b.lte);
  }
  const term = filters.search.trim();
  if (term) {
    const p = `%${escapeIlike(term)}%`;
    q = q.or(
      [
        `from_email.ilike.${p}`,
        `subject.ilike.${p}`,
        `message_id.ilike.${p}`,
        `ai_summary.ilike.${p}`,
      ].join(","),
    );
  }
  return q;
}

export async function fetchWorkbenchEmailList(
  supabase: SupabaseClient,
  filters: WorkbenchListFilters,
  page: number,
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const from = page * WORKBENCH_LIST_PAGE_SIZE;
  const to = from + WORKBENCH_LIST_PAGE_SIZE - 1;

  let listQuery = supabase
    .from("emails")
    .select(`${WORKBENCH_EMAIL_LIST_SELECT}, email_order_links ( id )`, { count: "exact" })
    .order("received_at", { ascending: false });

  listQuery = applyWorkbenchListFilters(listQuery, filters);

  const { data, error, count } = await listQuery.range(from, to);
  if (error) throw error;

  return {
    rows: (data ?? []) as Record<string, unknown>[],
    total: count ?? 0,
  };
}
