-- 邮件正文/元数据拉取队列：历史轻量发现后由后台 worker 逐封拉取

CREATE TABLE IF NOT EXISTS public.email_fetch_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id uuid NOT NULL REFERENCES public.mailboxes(id) ON DELETE CASCADE,
  email_id uuid REFERENCES public.emails(id) ON DELETE CASCADE,
  uid bigint NOT NULL,
  message_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  priority text NOT NULL DEFAULT 'background',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 6,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  locked_at timestamptz,
  locked_by text,
  fetched_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_fetch_tasks_status_chk CHECK (
    status IN ('pending', 'running', 'resolved', 'failed', 'skipped')
  ),
  CONSTRAINT email_fetch_tasks_priority_chk CHECK (
    priority IN ('interactive', 'background')
  ),
  CONSTRAINT email_fetch_tasks_mailbox_uid_key UNIQUE (mailbox_id, uid)
);

COMMENT ON TABLE public.email_fetch_tasks IS
  '邮件拉取任务队列：历史轻量发现后后台补拉正文与附件元数据。';

CREATE INDEX IF NOT EXISTS idx_email_fetch_tasks_due
  ON public.email_fetch_tasks (status, next_run_at)
  WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_email_fetch_tasks_email
  ON public.email_fetch_tasks (email_id);

ALTER TABLE public.email_fetch_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "员工可查看邮件拉取任务" ON public.email_fetch_tasks;
CREATE POLICY "员工可查看邮件拉取任务"
  ON public.email_fetch_tasks FOR SELECT
  TO authenticated
  USING (public.is_staff(auth.uid()));

DROP TRIGGER IF EXISTS trg_email_fetch_tasks_updated ON public.email_fetch_tasks;
CREATE TRIGGER trg_email_fetch_tasks_updated
  BEFORE UPDATE ON public.email_fetch_tasks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
