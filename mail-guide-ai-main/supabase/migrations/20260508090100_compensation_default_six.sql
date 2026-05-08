-- Phase A-2: order_compensation_tasks.max_retries 默认值改为 6（全局统一，不按店铺区分）

ALTER TABLE public.order_compensation_tasks
  ALTER COLUMN max_retries SET DEFAULT 6;

UPDATE public.order_compensation_tasks
SET max_retries = 6
WHERE status = 'pending' AND max_retries < 6;

COMMENT ON COLUMN public.order_compensation_tasks.max_retries IS
  '订单补偿任务最大重试次数，默认 6；与 next_run_at 配合实现「每小时 1 次、最多 6 次」策略。';
