-- 加速 schedule-compensating-alerts 扫描

CREATE INDEX IF NOT EXISTS idx_emails_compensating_received
  ON public.emails (association_status, received_at)
  WHERE association_status = 'compensating';
