const CST_OFFSET = "+08:00";

/** 日期控件 YYYY-MM-DD → 当日 00:00:00（东八区）的 UTC ISO 字符串，供 Supabase 区间查询 */
export function cstDayStartIso(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00${CST_OFFSET}`).toISOString();
}

/** 日期控件 YYYY-MM-DD → 当日 23:59:59.999（东八区）的 UTC ISO 字符串，供 Supabase 区间查询 */
export function cstDayEndIso(dateStr: string): string {
  return new Date(`${dateStr}T23:59:59.999${CST_OFFSET}`).toISOString();
}

/** 指定时刻在东八区的日历日期 YYYY-MM-DD（供 date 控件默认值） */
export function cstTodayDateStr(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** 东八区日历上 N 天前的 YYYY-MM-DD */
export function cstDateStrDaysAgo(days: number, ref: Date = new Date()): string {
  const anchor = new Date(`${cstTodayDateStr(ref)}T12:00:00${CST_OFFSET}`);
  anchor.setDate(anchor.getDate() - days);
  return cstTodayDateStr(anchor);
}

export function formatDateTimeCST(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

/** 工作台列表行：MM/dd HH:mm（北京时间） */
export function formatListDateTimeCST(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${pick("month")}/${pick("day")} ${pick("hour")}:${pick("minute")}`;
}
