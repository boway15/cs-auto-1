import { createAlertAndNotify } from "./ops-notify.ts";
import {
  autoInterceptAlertKey,
  autoInterceptAlertKeyByEmail,
} from "./automation-alert-keys.ts";

/** 自动拦截首次失败（进入 retrying 或 HTTP 调用失败） */
export async function notifyAutoInterceptFirstFailure(
  admin: any,
  opts: {
    email_id: string | null;
    order_id: string | null;
    order_no: string;
    log_id?: string | null;
    message: string;
    email_provided_only?: boolean;
    trigger_source?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  if (!opts.email_id) return;
  // process-email may see the same risk-intercept failure as an HTTP 500 after
  // risk-intercept has already persisted the log and emitted the first alert.
  // Use the stable email/order reference for the first phase so both paths dedupe.
  const orderRef = opts.order_id ?? opts.order_no ?? opts.log_id ?? "none";
  const idempotencyKey = autoInterceptAlertKeyByEmail("first", opts.email_id, String(orderRef));

  await createAlertAndNotify(admin, {
    source: "risk-intercept",
    kind: "auto_failed_first",
    title: opts.email_provided_only
      ? "[首次] 自动拦截失败（邮件单号）"
      : "[首次] 自动拦截失败",
    message: opts.message,
    related_email_id: opts.email_id,
    related_order_id: opts.order_id,
    severity: "warning",
    idempotency_key: idempotencyKey,
    metadata: {
      phase: "first",
      order_no: opts.order_no,
      log_id: opts.log_id ?? null,
      trigger_source: opts.trigger_source ?? "auto",
      ...opts.metadata,
    },
  });
}

/** 自动拦截末次失败（用尽补偿或策略终态） */
export async function notifyAutoInterceptFinalFailure(
  admin: any,
  opts: {
    email_id: string | null;
    order_id: string | null;
    order_no: string;
    log_id: string;
    message: string;
    email_provided_only?: boolean;
    reason?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  if (!opts.email_id || !opts.log_id) return;

  await createAlertAndNotify(admin, {
    source: "risk-intercept",
    kind: "auto_failed_final",
    title: opts.email_provided_only
      ? "[末次] 自动拦截失败（邮件单号，已结束重试）"
      : "[末次] 自动拦截失败（已结束重试）",
    message: opts.message,
    related_email_id: opts.email_id,
    related_order_id: opts.order_id,
    severity: "critical",
    idempotency_key: autoInterceptAlertKey("final", opts.email_id, opts.log_id),
    metadata: {
      phase: "final",
      order_no: opts.order_no,
      log_id: opts.log_id,
      reason: opts.reason ?? "exhausted",
      ...opts.metadata,
    },
  });
  await admin.from("emails").update({ priority: "urgent" }).eq("id", opts.email_id);
}

/** 补偿任务将 risk_intercept_logs 直接置 failed 时发末次告警（策略关停等） */
export async function notifyAutoInterceptFinalFromLogRow(
  admin: any,
  log: {
    id: string;
    email_id?: string | null;
    order_id?: string | null;
    referenced_order_no?: string | null;
    error_message?: string | null;
  },
  reason: string,
): Promise<void> {
  const emailId = log.email_id ? String(log.email_id) : null;
  if (!emailId) return;
  const orderNo = String(log.referenced_order_no ?? "").trim() || "—";
  const emailProvidedOnly = !log.order_id && !!log.referenced_order_no;
  await notifyAutoInterceptFinalFailure(admin, {
    email_id: emailId,
    order_id: log.order_id ? String(log.order_id) : null,
    order_no: orderNo,
    log_id: String(log.id),
    message: String(log.error_message ?? reason),
    email_provided_only: emailProvidedOnly,
    reason,
    metadata: { closed_by: "retry-risk-intercept-compensation" },
  });
}
