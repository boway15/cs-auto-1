/** 自动风控拦截 + 客户侧自动处理时间窗（与 production-go-live §5.5 / 帮助中心一致） */

/** 自动关联、自动拦截、自动回邮共用发件时间窗 */
export const CUSTOMER_AUTOMATION_WINDOW_MS = 12 * 60 * 60 * 1000;

/** 订单关联 / 拦截补偿两次尝试最小间隔（与 pg_cron 每 20 分钟对齐） */
export const COMPENSATION_STEP_MS = 20 * 60 * 1000;

/** 补偿次数上限（不含收信首次；总尝试 = 1 + MAX_COMPENSATION_ATTEMPTS） */
export const MAX_COMPENSATION_ATTEMPTS = 20;

export function nextCompensationRunAtIso(fromMs: number = Date.now()): string {
  return new Date(fromMs + COMPENSATION_STEP_MS).toISOString();
}

/** 邮件 received_at 在 12h 内才允许自动关联/拦截/回邮；缺失视为不允许 */
export function isEmailWithinCustomerAutomationAge(receivedAt: string | null | undefined): boolean {
  if (!receivedAt) return false;
  const t = Date.parse(receivedAt);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= CUSTOMER_AUTOMATION_WINDOW_MS;
}

/** @deprecated 使用 isEmailWithinCustomerAutomationAge */
export function isEmailWithinAutoRiskInterceptAge(receivedAt: string | null | undefined): boolean {
  return isEmailWithinCustomerAutomationAge(receivedAt);
}

// deno-lint-ignore no-explicit-any
export async function getRiskAutoInterceptEnabled(admin: any): Promise<boolean> {
  const { data, error } = await admin
    .from("automation_settings")
    .select("risk_auto_intercept_enabled")
    .eq("singleton", "default")
    .maybeSingle();
  if (error) {
    console.warn("getRiskAutoInterceptEnabled:", error);
    return false;
  }
  if (!data) return false;
  const row = data as { risk_auto_intercept_enabled?: boolean | null };
  return row.risk_auto_intercept_enabled === true;
}

export type AutoRiskInterceptPolicyResult =
  | { ok: true }
  | { ok: false; reason: "disabled" | "stale_email" | "no_received_at" };

export async function assertAutoRiskInterceptAllowed(
  admin: any,
  emailId: string | null | undefined,
): Promise<AutoRiskInterceptPolicyResult> {
  const enabled = await getRiskAutoInterceptEnabled(admin);
  if (!enabled) return { ok: false, reason: "disabled" };
  if (!emailId) return { ok: false, reason: "no_received_at" };
  const { data, error } = await admin
    .from("emails")
    .select("received_at")
    .eq("id", emailId)
    .maybeSingle();
  if (error || !data) return { ok: false, reason: "no_received_at" };
  const receivedAt = (data as { received_at?: string | null }).received_at;
  if (!isEmailWithinCustomerAutomationAge(receivedAt ?? null)) {
    return { ok: false, reason: "stale_email" };
  }
  return { ok: true };
}
