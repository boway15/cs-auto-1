function parseEnvPositiveInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name)?.trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type SlaWindow = {
  ok: true;
  since: Date;
  before: Date;
  hours: number;
};

export type SlaWindowError = {
  ok: false;
  error: string;
};

/** 滚动 SLA 时间窗：since = now - hours, before = now */
export function parseSlaWindow(
  hours: number,
  options?: { now?: Date; widenMinutes?: number },
): SlaWindow | SlaWindowError {
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
    return { ok: false, error: "sync_sla_hours 须为 1～168 之间的整数" };
  }
  const before = options?.now ?? new Date();
  const widenMin = options?.widenMinutes ??
    parseEnvPositiveInt("MAIL_SYNC_SLA_WIDEN_MINUTES", 0);
  const since = new Date(before.getTime() - hours * 3600 * 1000 - widenMin * 60 * 1000);
  return { ok: true, since, before, hours };
}

/** Date 头是否在 [since, before) 半开区间；无/无效 Date 时不排除（依赖 IMAP 扩窗已收窄） */
export function emailHeaderWithinSlaWindow(
  dateHeader: string | null | undefined,
  since: Date,
  before: Date,
): boolean {
  if (!dateHeader?.trim()) return true;
  const parsed = new Date(dateHeader);
  if (Number.isNaN(parsed.getTime())) return true;
  const t = parsed.getTime();
  return t >= since.getTime() && t < before.getTime();
}
