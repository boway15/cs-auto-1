-- 记录首次进入自动补偿 retrying 的时刻，供补偿任务将「超过 4 小时仍在 retrying」置为失败

ALTER TABLE public.risk_intercept_logs
  ADD COLUMN IF NOT EXISTS retrying_started_at timestamptz;

COMMENT ON COLUMN public.risk_intercept_logs.retrying_started_at IS
  '自动拦截首次进入 status=retrying 且可补偿时写入；补偿 Edge 每次执行时将 (now - 本字段) > 4h 仍 retrying 的行置为 failed。';

UPDATE public.risk_intercept_logs
SET retrying_started_at = COALESCE(retrying_started_at, created_at)
WHERE status = 'retrying'
  AND auto_compensation_eligible = true
  AND retrying_started_at IS NULL;
