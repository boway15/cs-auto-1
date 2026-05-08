CREATE TABLE public.email_send_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id uuid REFERENCES public.emails(id) ON DELETE SET NULL,
  mailbox_id uuid REFERENCES public.mailboxes(id) ON DELETE SET NULL,
  to_email text NOT NULL,
  from_email text,
  subject text,
  content text,
  send_type text NOT NULL DEFAULT 'manual',
  status text NOT NULL DEFAULT 'sent',
  error_message text,
  message_id text,
  sent_by uuid,
  template_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_send_logs_email_id ON public.email_send_logs(email_id);
CREATE INDEX idx_email_send_logs_created_at ON public.email_send_logs(created_at DESC);
CREATE INDEX idx_email_send_logs_status ON public.email_send_logs(status);

ALTER TABLE public.email_send_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "登录用户可查看发送日志"
  ON public.email_send_logs FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "员工可写入发送日志"
  ON public.email_send_logs FOR INSERT
  TO authenticated WITH CHECK (public.is_staff(auth.uid()));

CREATE POLICY "管理员可删除发送日志"
  ON public.email_send_logs FOR DELETE
  TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role));