-- Phase A-3: ops_alerts 增加幂等键与发邮记录，便于「同一事件不重复发邮件」

ALTER TABLE public.ops_alerts
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS email_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_send_error text;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_ops_alerts_idem
  ON public.ops_alerts(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ops_alerts_status_created
  ON public.ops_alerts(status, created_at DESC);

COMMENT ON COLUMN public.ops_alerts.idempotency_key IS
  '告警幂等键，建议格式 {source}:{kind}:{related_email_id}:{related_order_id}；同 key 仅产生一条告警与一封通知邮件。';
COMMENT ON COLUMN public.ops_alerts.email_sent_at IS '告警通知邮件首次成功发送时间。';
COMMENT ON COLUMN public.ops_alerts.email_send_error IS '告警通知邮件最近一次发送失败的错误信息。';
