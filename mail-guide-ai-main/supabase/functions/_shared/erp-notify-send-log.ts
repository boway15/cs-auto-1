/** ERP 拦截通知：422 等预发信失败日志（不写入 idempotency_key） */

export type ErpNotifyFailureLogInput = {
  template_code: string;
  order_no: string;
  item_count: number;
  site_code: string;
  to_email: string;
  error_code: string;
  error_message: string;
  failure_stage: string;
  erp_template_id?: string | null;
  site_name?: string | null;
  from_email?: string | null;
};

export type ErpNotifyFailureLogResult = {
  send_log_id: string;
  send_no: string | null;
};

export async function insertErpNotifyFailureLog(
  admin: {
    from: (table: string) => {
      insert: (row: Record<string, unknown>) => {
        select: (cols: string) => {
          single: () => Promise<{
            data: { id: string; send_no: string | null } | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  },
  input: ErpNotifyFailureLogInput,
): Promise<ErpNotifyFailureLogResult> {
  const metadata: Record<string, unknown> = {
    source: "erp",
    template_code: input.template_code,
    order_no: input.order_no,
    item_count: input.item_count,
    site_code: input.site_code,
    error_code: input.error_code,
    failure_stage: input.failure_stage,
  };
  if (input.site_name != null) metadata.site_name = input.site_name;
  if (input.erp_template_id) metadata.erp_template_id = input.erp_template_id;

  const { data, error } = await admin
    .from("email_send_logs")
    .insert({
      email_id: null,
      mailbox_id: null,
      template_id: null,
      order_id: null,
      to_email: input.to_email,
      from_email: input.from_email ?? null,
      subject: null,
      content: null,
      send_type: "erp_notify",
      status: "failed",
      error_message: input.error_message,
      smtp_response: null,
      message_id: null,
      sent_by: null,
      retry_count: 0,
      idempotency_key: null,
      metadata,
    })
    .select("id, send_no")
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "写入发送日志失败");
  }

  return { send_log_id: data.id, send_no: data.send_no };
}
