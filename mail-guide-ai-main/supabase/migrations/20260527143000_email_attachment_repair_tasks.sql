-- 超大附件补拉队列：交互触发入队，后台任务重试处理

CREATE TABLE IF NOT EXISTS public.email_attachment_repair_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id uuid NOT NULL REFERENCES public.emails(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  priority text NOT NULL DEFAULT 'background',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 6,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  locked_at timestamptz,
  locked_by text,
  repaired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_attachment_repair_tasks_status_chk CHECK (
    status IN ('pending', 'running', 'resolved', 'failed', 'skipped')
  ),
  CONSTRAINT email_attachment_repair_tasks_priority_chk CHECK (
    priority IN ('interactive', 'background')
  ),
  CONSTRAINT email_attachment_repair_tasks_email_id_key UNIQUE (email_id)
);

COMMENT ON TABLE public.email_attachment_repair_tasks IS
  '邮件附件补拉任务队列：针对超大附件 Worker 超时场景，后台重试。';

CREATE INDEX IF NOT EXISTS idx_email_attachment_repair_tasks_due
  ON public.email_attachment_repair_tasks (status, next_run_at)
  WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_email_attachment_repair_tasks_email
  ON public.email_attachment_repair_tasks (email_id);

ALTER TABLE public.email_attachment_repair_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "员工可查看附件补拉任务" ON public.email_attachment_repair_tasks;
CREATE POLICY "员工可查看附件补拉任务"
  ON public.email_attachment_repair_tasks FOR SELECT
  TO authenticated
  USING (public.is_staff(auth.uid()));

DROP TRIGGER IF EXISTS trg_email_attachment_repair_tasks_updated ON public.email_attachment_repair_tasks;
CREATE TRIGGER trg_email_attachment_repair_tasks_updated
  BEFORE UPDATE ON public.email_attachment_repair_tasks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
