CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS ai_entities jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS is_info_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_summary text,
  ADD COLUMN IF NOT EXISTS association_status text NOT NULL DEFAULT 'unlinked',
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS thread_id text,
  ADD COLUMN IF NOT EXISTS processing_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS risk_level text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS ai_analyzed_at timestamptz,
  ADD COLUMN IF NOT EXISTS first_response_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS is_first_email boolean NOT NULL DEFAULT false;

ALTER TABLE public.email_send_logs
  ADD COLUMN IF NOT EXISTS send_no text,
  ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS smtp_response text,
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'smtp',
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE public.email_send_logs
SET send_no = 'SND-' || to_char(created_at, 'YYYYMMDD') || '-' || upper(substr(id::text, 1, 8))
WHERE send_no IS NULL;

ALTER TABLE public.email_send_logs
  ALTER COLUMN send_no SET DEFAULT ('SND-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 8)));

ALTER TABLE public.reply_templates
  ADD COLUMN IF NOT EXISTS intent text,
  ADD COLUMN IF NOT EXISTS cooldown_minutes integer NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS variables jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_by uuid,
  ADD COLUMN IF NOT EXISTS last_tested_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_test_result jsonb;

ALTER TABLE public.mailboxes
  ADD COLUMN IF NOT EXISTS failure_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS disabled_reason text,
  ADD COLUMN IF NOT EXISTS last_imap_test_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_smtp_test_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_test_result jsonb,
  ADD COLUMN IF NOT EXISTS auth_password_encrypted bytea,
  ADD COLUMN IF NOT EXISTS config_audit jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.erp_configs
  ADD COLUMN IF NOT EXISTS auth_token_encrypted bytea,
  ADD COLUMN IF NOT EXISTS last_tested_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_test_result jsonb,
  ADD COLUMN IF NOT EXISTS config_audit jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.email_order_links
  ADD COLUMN IF NOT EXISTS confidence numeric,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.email_order_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id uuid NOT NULL REFERENCES public.emails(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  reason text NOT NULL,
  score numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(email_id, order_id)
);

ALTER TABLE public.email_order_recommendations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "员工可查看订单推荐" ON public.email_order_recommendations;
CREATE POLICY "员工可查看订单推荐"
  ON public.email_order_recommendations FOR SELECT
  TO authenticated USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "员工可管理订单推荐" ON public.email_order_recommendations;
CREATE POLICY "员工可管理订单推荐"
  ON public.email_order_recommendations FOR ALL
  TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

CREATE TABLE IF NOT EXISTS public.order_compensation_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id uuid NOT NULL REFERENCES public.emails(id) ON DELETE CASCADE,
  order_no text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  retry_count integer NOT NULL DEFAULT 0,
  max_retries integer NOT NULL DEFAULT 3,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  resolved_order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(email_id, order_no)
);

ALTER TABLE public.order_compensation_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "员工可查看补偿任务" ON public.order_compensation_tasks;
CREATE POLICY "员工可查看补偿任务"
  ON public.order_compensation_tasks FOR SELECT
  TO authenticated USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "员工可管理补偿任务" ON public.order_compensation_tasks;
CREATE POLICY "员工可管理补偿任务"
  ON public.order_compensation_tasks FOR ALL
  TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

CREATE TABLE IF NOT EXISTS public.risk_intercept_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intercept_no text NOT NULL DEFAULT ('RISK-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 8))),
  email_id uuid REFERENCES public.emails(id) ON DELETE SET NULL,
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  action text NOT NULL DEFAULT 'hold',
  intercept_reason text,
  reason_category text,
  trigger_source text NOT NULL DEFAULT 'manual',
  status text NOT NULL DEFAULT 'pending',
  retry_count integer NOT NULL DEFAULT 0,
  erp_response jsonb,
  shopify_response jsonb,
  error_message text,
  operated_by uuid,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(intercept_no)
);

ALTER TABLE public.risk_intercept_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "员工可查看风控日志" ON public.risk_intercept_logs;
CREATE POLICY "员工可查看风控日志"
  ON public.risk_intercept_logs FOR SELECT
  TO authenticated USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "员工可创建风控日志" ON public.risk_intercept_logs;
CREATE POLICY "员工可创建风控日志"
  ON public.risk_intercept_logs FOR INSERT
  TO authenticated WITH CHECK (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "员工可更新风控日志" ON public.risk_intercept_logs;
CREATE POLICY "员工可更新风控日志"
  ON public.risk_intercept_logs FOR UPDATE
  TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

CREATE TABLE IF NOT EXISTS public.ops_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  severity text NOT NULL DEFAULT 'warning',
  title text NOT NULL,
  message text,
  related_email_id uuid REFERENCES public.emails(id) ON DELETE SET NULL,
  related_order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

ALTER TABLE public.ops_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "员工可查看告警" ON public.ops_alerts;
CREATE POLICY "员工可查看告警"
  ON public.ops_alerts FOR SELECT
  TO authenticated USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "员工可管理告警" ON public.ops_alerts;
CREATE POLICY "员工可管理告警"
  ON public.ops_alerts FOR ALL
  TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

CREATE TABLE IF NOT EXISTS public.email_processing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id uuid REFERENCES public.emails(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_type text NOT NULL DEFAULT 'system',
  actor_id uuid,
  title text NOT NULL,
  detail text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.email_processing_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "员工可查看处理时间线" ON public.email_processing_events;
CREATE POLICY "员工可查看处理时间线"
  ON public.email_processing_events FOR SELECT
  TO authenticated USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "员工可写入处理时间线" ON public.email_processing_events;
CREATE POLICY "员工可写入处理时间线"
  ON public.email_processing_events FOR INSERT
  TO authenticated WITH CHECK (public.is_staff(auth.uid()));

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  target_table text NOT NULL,
  target_id uuid,
  action text NOT NULL,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "管理员可查看审计日志" ON public.audit_logs;
CREATE POLICY "管理员可查看审计日志"
  ON public.audit_logs FOR SELECT
  TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "员工可创建审计日志" ON public.audit_logs;
CREATE POLICY "员工可创建审计日志"
  ON public.audit_logs FOR INSERT
  TO authenticated WITH CHECK (public.is_staff(auth.uid()));

CREATE TABLE IF NOT EXISTS public.email_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id uuid NOT NULL REFERENCES public.emails(id) ON DELETE CASCADE,
  filename text NOT NULL,
  content_type text,
  size_bytes bigint,
  storage_bucket text NOT NULL DEFAULT 'email-attachments',
  storage_path text,
  download_status text NOT NULL DEFAULT 'pending',
  warning text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.email_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "员工可查看附件记录" ON public.email_attachments;
CREATE POLICY "员工可查看附件记录"
  ON public.email_attachments FOR SELECT
  TO authenticated USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "员工可管理附件记录" ON public.email_attachments;
CREATE POLICY "员工可管理附件记录"
  ON public.email_attachments FOR ALL
  TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

INSERT INTO storage.buckets (id, name, public)
VALUES ('email-attachments', 'email-attachments', false)
ON CONFLICT (id) DO UPDATE SET public = false;

CREATE OR REPLACE FUNCTION public.encrypt_secret(secret text)
RETURNS bytea
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT CASE
    WHEN secret IS NULL OR current_setting('app.settings.encryption_key', true) IS NULL THEN NULL
    ELSE pgp_sym_encrypt(secret, current_setting('app.settings.encryption_key', true))
  END
$$;

CREATE OR REPLACE FUNCTION public.record_email_event(
  _email_id uuid,
  _event_type text,
  _title text,
  _detail text DEFAULT NULL,
  _metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.email_processing_events(email_id, event_type, title, detail, metadata)
  VALUES (_email_id, _event_type, _title, _detail, COALESCE(_metadata, '{}'::jsonb));
END;
$$;

DROP TRIGGER IF EXISTS trg_order_compensation_tasks_updated ON public.order_compensation_tasks;
CREATE TRIGGER trg_order_compensation_tasks_updated
  BEFORE UPDATE ON public.order_compensation_tasks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_risk_intercept_logs_updated ON public.risk_intercept_logs;
CREATE TRIGGER trg_risk_intercept_logs_updated
  BEFORE UPDATE ON public.risk_intercept_logs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_emails_association_status ON public.emails(association_status);
CREATE INDEX IF NOT EXISTS idx_emails_priority ON public.emails(priority, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_thread_id ON public.emails(thread_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_idempotency_key ON public.emails(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_send_logs_order_id ON public.email_send_logs(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_send_logs_idempotency ON public.email_send_logs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_order_compensation_due ON public.order_compensation_tasks(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_risk_intercept_email ON public.risk_intercept_logs(email_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_risk_intercept_idempotency ON public.risk_intercept_logs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_processing_events_email ON public.email_processing_events(email_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_attachments_email ON public.email_attachments(email_id);
CREATE INDEX IF NOT EXISTS idx_orders_email_ordered_at ON public.orders(customer_email, ordered_at DESC);
