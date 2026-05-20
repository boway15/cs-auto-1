-- Phase A：自动关联/拦截补偿上限 20 次（收信 1 + 补偿 20），与 12h/20min 文档口径一致

ALTER TABLE public.risk_intercept_logs
  DROP CONSTRAINT IF EXISTS risk_intercept_logs_compensation_attempts_done_chk;

ALTER TABLE public.risk_intercept_logs
  ADD CONSTRAINT risk_intercept_logs_compensation_attempts_done_chk
  CHECK (compensation_attempts_done >= 0 AND compensation_attempts_done <= 20);

COMMENT ON COLUMN public.risk_intercept_logs.compensation_attempts_done IS
  '已完成的补偿调用次数（不含收信首次尝试）；达到 20 且仍失败则 status=failed。';

ALTER TABLE public.order_compensation_tasks
  ALTER COLUMN max_retries SET DEFAULT 20;

COMMENT ON COLUMN public.order_compensation_tasks.max_retries IS
  '补偿重试上限（不含 process-email 首次查单）；默认 20，对应总尝试约 21 次。';
