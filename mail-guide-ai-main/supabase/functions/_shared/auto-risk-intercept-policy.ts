/** 自动风控拦截：开关 + 发件时间窗（与 customer-service-automation-spec §6.4 一致） */

const WINDOW_MS = 24 * 60 * 60 * 1000;

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

/** 邮件发件/解析时间（received_at）在 24h 内才允许自动拦截；缺失视为不允许 */
export function isEmailWithinAutoRiskInterceptAge(receivedAt: string | null | undefined): boolean {
  if (!receivedAt) return false;
  const t = Date.parse(receivedAt);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= WINDOW_MS;
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
  if (!isEmailWithinAutoRiskInterceptAge(receivedAt ?? null)) {
    return { ok: false, reason: "stale_email" };
  }
  return { ok: true };
}
