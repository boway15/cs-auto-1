// 统一告警模块：写 ops_alerts + 幂等去重 + 通过指定邮箱发告警邮件
// 使用方式：
//   import { createAlertAndNotify } from "../_shared/ops-notify.ts";
//   await createAlertAndNotify(admin, {
//     source: "risk-intercept", kind: "failed",
//     title: "风控拦截失败",
//     message: errorText,
//     related_email_id, related_order_id,
//   });

import { sendMail } from "./smtp.ts";

const ALERT_SENDER_ADDRESS =
  Deno.env.get("ALERT_SENDER_ADDRESS") || "caobaowei123@163.com";
const ALERT_EMAIL_TO =
  Deno.env.get("ALERT_EMAIL_TO") || "caobaowei@bestwo.com";

export interface AlertInput {
  source: string;
  kind: string;
  title: string;
  message?: string | null;
  severity?: "info" | "warning" | "critical";
  related_email_id?: string | null;
  related_order_id?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AlertResult {
  alert_id: string | null;
  email_sent: boolean;
  deduped: boolean;
  error?: string | null;
}

function buildIdempotencyKey(payload: AlertInput): string {
  const e = payload.related_email_id ?? "none";
  const o = payload.related_order_id ?? "none";
  return `${payload.source}:${payload.kind}:${e}:${o}`;
}

function renderEmail(payload: AlertInput, idempotencyKey: string): { subject: string; text: string } {
  const subject = `[mail-guide-ai 告警] ${payload.title}`;
  const lines = [
    `严重级别：${payload.severity ?? "warning"}`,
    `事件来源：${payload.source}`,
    `事件类型：${payload.kind}`,
    `关联邮件：${payload.related_email_id ?? "-"}`,
    `关联订单：${payload.related_order_id ?? "-"}`,
    `幂等键：${idempotencyKey}`,
    "",
    "事件详情：",
    payload.message ?? "(无)",
  ];
  if (payload.metadata && Object.keys(payload.metadata).length > 0) {
    lines.push("", "元数据：", JSON.stringify(payload.metadata, null, 2));
  }
  lines.push("", "—— mail-guide-ai 自动告警，请勿直接回复。");
  return { subject, text: lines.join("\n") };
}

/**
 * 写入 ops_alerts 并按需发送告警邮件。
 * 同一 idempotency_key 下：
 *   1) ops_alerts 仅一条；
 *   2) 告警邮件仅首次成功发送一次（email_sent_at IS NULL 时才尝试发）。
 */
export async function createAlertAndNotify(
  admin: any,
  payload: AlertInput,
): Promise<AlertResult> {
  const idempotencyKey = buildIdempotencyKey(payload);
  const severity = payload.severity ?? "warning";

  // 1) 查重
  const { data: existing } = await admin
    .from("ops_alerts")
    .select("id, email_sent_at")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  let alertId = existing?.id as string | null;
  let deduped = !!existing;

  if (!existing) {
    const { data: inserted, error: insertErr } = await admin
      .from("ops_alerts")
      .insert({
        source: payload.source,
        severity,
        title: payload.title,
        message: payload.message ?? null,
        related_email_id: payload.related_email_id ?? null,
        related_order_id: payload.related_order_id ?? null,
        metadata: payload.metadata ?? {},
        idempotency_key: idempotencyKey,
      })
      .select("id, email_sent_at")
      .single();
    if (insertErr) {
      console.error("[ops-notify] insert ops_alerts failed:", insertErr);
      return { alert_id: null, email_sent: false, deduped: false, error: insertErr.message };
    }
    alertId = inserted.id;
    deduped = false;
  }

  // 2) 仅首次发邮（email_sent_at 为空时尝试）
  const needSend = !existing || !existing.email_sent_at;
  if (!needSend) {
    return { alert_id: alertId, email_sent: false, deduped: true };
  }

  // 取告警发件邮箱配置
  const { data: mailbox } = await admin
    .from("mailboxes")
    .select("smtp_host, smtp_port, auth_user, auth_password, email_address, display_name, is_active")
    .eq("email_address", ALERT_SENDER_ADDRESS)
    .maybeSingle();

  if (!mailbox || !mailbox.smtp_host || !mailbox.smtp_port || !mailbox.auth_user || !mailbox.auth_password) {
    const errMsg = `告警发件邮箱 ${ALERT_SENDER_ADDRESS} 未在 mailboxes 中正确配置 SMTP，跳过发邮（告警仍写入 ops_alerts）`;
    console.error("[ops-notify]", errMsg);
    if (alertId) {
      await admin
        .from("ops_alerts")
        .update({ email_send_error: errMsg })
        .eq("id", alertId);
    }
    return { alert_id: alertId, email_sent: false, deduped, error: errMsg };
  }

  const { subject, text } = renderEmail(payload, idempotencyKey);

  try {
    await sendMail(
      {
        smtp_host: mailbox.smtp_host,
        smtp_port: Number(mailbox.smtp_port),
        auth_user: mailbox.auth_user,
        auth_password: mailbox.auth_password,
        email_address: mailbox.email_address,
        display_name: mailbox.display_name ?? "mail-guide-ai 告警",
      },
      { to: ALERT_EMAIL_TO, subject, text },
    );
    if (alertId) {
      await admin
        .from("ops_alerts")
        .update({ email_sent_at: new Date().toISOString(), email_send_error: null })
        .eq("id", alertId);
    }
    return { alert_id: alertId, email_sent: true, deduped };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[ops-notify] sendMail failed:", errMsg);
    if (alertId) {
      await admin
        .from("ops_alerts")
        .update({ email_send_error: errMsg })
        .eq("id", alertId);
    }
    return { alert_id: alertId, email_sent: false, deduped, error: errMsg };
  }
}
