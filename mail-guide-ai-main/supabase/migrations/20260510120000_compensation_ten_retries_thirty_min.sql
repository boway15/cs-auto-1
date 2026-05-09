-- 补偿任务：默认最多 10 次重试；调度间隔由 Edge（run-compensation-tasks / process-email）改为 30 分钟

ALTER TABLE public.order_compensation_tasks
  ALTER COLUMN max_retries SET DEFAULT 10;

UPDATE public.order_compensation_tasks
SET max_retries = 10
WHERE status = 'pending' AND COALESCE(max_retries, 0) < 10;

COMMENT ON COLUMN public.order_compensation_tasks.max_retries IS
  '最多重试次数，默认 10；下次运行时间由 Edge 设为 +30 分钟';
