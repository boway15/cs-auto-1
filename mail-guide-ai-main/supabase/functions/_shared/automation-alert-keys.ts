/** 自动拦截 / 自动关联运营告警幂等键（首次与末次各一条 ops_alerts + 各一封邮件） */

export type AutomationAlertPhase = "first" | "final";

export function autoInterceptAlertKey(
  phase: AutomationAlertPhase,
  emailId: string,
  logId: string,
): string {
  return `auto-intercept:${phase}:${emailId}:${logId}`;
}

/** process-email HTTP 调 risk-intercept 失败时尚未有 log 行，用邮件+订单维度 */
export function autoInterceptAlertKeyByEmail(
  phase: AutomationAlertPhase,
  emailId: string,
  orderRef: string,
): string {
  return `auto-intercept:${phase}:${emailId}:ref:${orderRef}`;
}

export function autoAssociationAlertKey(
  phase: AutomationAlertPhase,
  emailId: string,
  orderNo: string,
): string {
  const no = String(orderNo ?? "").trim().toLowerCase() || "unknown";
  return `auto-association:${phase}:${emailId}:${no}`;
}
