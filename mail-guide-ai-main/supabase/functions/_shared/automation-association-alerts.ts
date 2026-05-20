import { createAlertAndNotify } from "./ops-notify.ts";
import { autoAssociationAlertKey } from "./automation-alert-keys.ts";

/** 收信首次查单/OMS 均未命中，已创建 order_compensation_tasks */
export async function notifyAutoAssociationFirstFailure(
  admin: any,
  opts: {
    email_id: string;
    order_no: string;
    from_email?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const msg = [
    "客户邮件已解析出订单号，但本地与 OMS 首次查单均未命中，已创建订单关联补偿任务。",
    `订单号：${opts.order_no}`,
    opts.from_email ? `发件人：${opts.from_email}` : "",
    "系统将每 20 分钟自动重试，用尽次数后将发送末次告警。",
  ].filter(Boolean).join("\n");

  await createAlertAndNotify(admin, {
    source: "run-compensation-tasks",
    kind: "auto_association_first",
    title: `[首次] 订单未关联：${opts.order_no}`,
    message: msg,
    related_email_id: opts.email_id,
    related_order_id: null,
    severity: "warning",
    idempotency_key: autoAssociationAlertKey("first", opts.email_id, opts.order_no),
    metadata: {
      phase: "first",
      order_no: opts.order_no,
      ...opts.metadata,
    },
  });
}

/** 关联补偿末次失败（用尽次数或策略终止） */
export async function notifyAutoAssociationFinalFailure(
  admin: any,
  opts: {
    email_id: string;
    order_no: string;
    task_id?: string;
    retry_count?: number;
    reason: string;
    message: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await createAlertAndNotify(admin, {
    source: "run-compensation-tasks",
    kind: "auto_association_final",
    title: `[末次] 订单关联失败：${opts.order_no}`,
    message: opts.message,
    related_email_id: opts.email_id,
    related_order_id: null,
    severity: opts.reason === "max_retries" ? "warning" : "warning",
    idempotency_key: autoAssociationAlertKey("final", opts.email_id, opts.order_no),
    metadata: {
      phase: "final",
      order_no: opts.order_no,
      task_id: opts.task_id ?? null,
      retry_count: opts.retry_count ?? null,
      reason: opts.reason,
      ...opts.metadata,
    },
  });
  await admin.from("emails").update({ priority: "high" }).eq("id", opts.email_id);
}
