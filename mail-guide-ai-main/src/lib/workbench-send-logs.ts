import { supabase } from "@/lib/supabase";

/** 工作台详情：挂靠入站邮件的发送日志 */
export type WorkbenchSendLog = {
  id: string;
  email_id: string | null;
  status: string;
  send_type: string;
  subject: string | null;
  content: string | null;
  from_email: string | null;
  to_email: string;
  message_id: string | null;
  error_message: string | null;
  created_at: string;
  sent_by: string | null;
  send_no: string | null;
  smtp_response: string | null;
  metadata?: Record<string, unknown> | null;
};

export const WORKBENCH_SEND_LOG_SELECT =
  "id, email_id, status, send_type, subject, content, from_email, to_email, message_id, error_message, created_at, sent_by, send_no, smtp_response, metadata";

const SEND_TYPE_LABEL: Record<string, string> = {
  manual: "手工回复",
  ai_draft: "AI 草稿",
  auto_template: "自动模板",
  erp_notify: "ERP 拦截通知",
};

export function sendTypeLabel(sendType: string): string {
  return SEND_TYPE_LABEL[sendType] ?? sendType;
}

export function isSendLogSuccess(status: string): boolean {
  return String(status).toLowerCase() === "sent";
}

export async function fetchWorkbenchSendLogsForEmails(
  emailIds: string[],
): Promise<{ data: WorkbenchSendLog[]; error: string | null }> {
  const ids = [...new Set(emailIds.filter(Boolean))];
  if (ids.length === 0) return { data: [], error: null };

  const { data, error } = await supabase
    .from("email_send_logs")
    .select(WORKBENCH_SEND_LOG_SELECT)
    .in("email_id", ids)
    .order("created_at", { ascending: true });

  if (error) {
    return { data: [], error: error.message };
  }
  return { data: (data ?? []) as WorkbenchSendLog[], error: null };
}

/** @deprecated 请用 fetchWorkbenchSendLogsForEmails */
export async function fetchWorkbenchSendLogsForEmail(
  emailId: string,
): Promise<{ data: WorkbenchSendLog[]; error: string | null }> {
  return fetchWorkbenchSendLogsForEmails([emailId]);
}

export type ConversationTimelineItem =
  | {
      kind: "inbound";
      id: string;
      at: string;
      email: {
        id: string;
        subject: string | null;
        body_text: string | null;
        received_at: string;
        status?: string;
        processing_status?: string;
        from_email?: string;
        from_name?: string | null;
      };
      isCurrent: boolean;
    }
  | {
      kind: "outbound";
      id: string;
      at: string;
      log: WorkbenchSendLog;
    };

/** 同发件人往来：入站邮件 + 对应已发回复，按时间倒序（新→旧） */
export function buildPairConversationTimeline(args: {
  currentEmail: {
    id: string;
    subject: string | null;
    body_text: string | null;
    received_at: string;
    status?: string;
    processing_status?: string;
    from_email?: string;
    from_name?: string | null;
  } | null;
  historyEmails: Array<{
    id: string;
    subject: string | null;
    body_text: string | null;
    received_at: string;
    status?: string;
    processing_status?: string;
    from_email?: string;
    from_name?: string | null;
  }>;
  sendLogs: WorkbenchSendLog[];
}): ConversationTimelineItem[] {
  const items: ConversationTimelineItem[] = [];

  if (args.currentEmail) {
    items.push({
      kind: "inbound",
      id: `in-${args.currentEmail.id}`,
      at: args.currentEmail.received_at,
      email: args.currentEmail,
      isCurrent: true,
    });
  }

  for (const email of args.historyEmails) {
    items.push({
      kind: "inbound",
      id: `in-${email.id}`,
      at: email.received_at,
      email,
      isCurrent: false,
    });
  }

  for (const log of args.sendLogs) {
    items.push({
      kind: "outbound",
      id: `out-${log.id}`,
      at: log.created_at,
      log,
    });
  }

  items.sort((a, b) => {
    const ta = new Date(a.at).getTime();
    const tb = new Date(b.at).getTime();
    return tb - ta;
  });

  return items;
}
