import type { SupabaseClient } from "@supabase/supabase-js";
import type { SlaBucket } from "@/lib/customerService";

/** 工作台列表每页条数（日收 1000–2000 封时避免一次拉全表） */
export const WORKBENCH_LIST_PAGE_SIZE = 50;

/** listDays=0 表示不限制收信时间（全部历史，仍分页） */
export const WORKBENCH_LIST_DAYS_ALL = 0;

export const WORKBENCH_LIST_DAYS_OPTIONS = [
  { value: 7, label: "近 7 天" },
  { value: 14, label: "近 14 天" },
  { value: 30, label: "近 30 天" },
  { value: 90, label: "近 90 天" },
  { value: 180, label: "近 180 天" },
  { value: 365, label: "近 1 年" },
  { value: WORKBENCH_LIST_DAYS_ALL, label: "全部历史" },
] as const;

export function workbenchListDaysLabel(listDays: number): string {
  const hit = WORKBENCH_LIST_DAYS_OPTIONS.find((o) => o.value === listDays);
  return hit?.label ?? `近 ${listDays} 天`;
}

/** 列表用字段（不含正文/HTML，详情在 loadDetail 再拉 *） */
export const WORKBENCH_EMAIL_LIST_SELECT =
  "id, message_id, from_email, from_name, to_email, subject, ai_summary, received_at, status, is_read, mailbox_id, category, business_intent, association_status, processing_status, missing_elements, ai_entities, intent_legacy, priority, risk_level, sla_bucket, attachments";

export type WorkbenchListFilters = {
  listDays: number;
  status: "all" | "pending" | "processing" | "replied";
  mailboxId: string;
  mailboxToEmail: string | null;
  category: string;
  association: string;
  intent: string;
  slaBucket: "all" | SlaBucket;
  search: string;
};

function listReceivedAfterIso(listDays: number): string {
  const ms = Date.now() - listDays * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

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
  if (filters.listDays > 0) {
    q = q.gte("received_at", listReceivedAfterIso(filters.listDays));
  }

  if (filters.status !== "all") {
    q = q.eq("status", filters.status);
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
  if (filters.category !== "all") {
    q = q.eq("category", filters.category);
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
