-- 自动风控拦截总开关 + 补偿调度字段（见 docs/customer-service-automation-spec.md §6.4）

ALTER TABLE public.automation_settings
  ADD COLUMN IF NOT EXISTS risk_auto_intercept_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.automation_settings.risk_auto_intercept_enabled IS
  '为 true 时允许 process-email / 补偿任务自动调用 risk-intercept 及 hourly 补偿；人工工作台拦截不受此开关约束。默认 false 以降低新绑定邮箱批量误拦风险。';

ALTER TABLE public.risk_intercept_logs
  ADD COLUMN IF NOT EXISTS auto_compensation_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS compensation_attempts_done integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_compensation_at timestamptz;

COMMENT ON COLUMN public.risk_intercept_logs.auto_compensation_eligible IS
  '仅自动链路首次失败且需补偿时为 true；人工拦截为 false。retry-risk-intercept-compensation 仅处理 eligible 且 retrying 的行。';
COMMENT ON COLUMN public.risk_intercept_logs.compensation_attempts_done IS
  '已完成的补偿调用次数（不含收信首次尝试），成功或失败每次 retry 调用后递增；达到 3 且仍失败则 status=failed。';
COMMENT ON COLUMN public.risk_intercept_logs.next_compensation_at IS
  '下次允许执行补偿 risk-intercept（trigger_source=retry）的最早时间；首次自动失败后通常为 now()+1h。';

ALTER TABLE public.risk_intercept_logs
  DROP CONSTRAINT IF EXISTS risk_intercept_logs_compensation_attempts_done_chk;
ALTER TABLE public.risk_intercept_logs
  ADD CONSTRAINT risk_intercept_logs_compensation_attempts_done_chk
  CHECK (compensation_attempts_done >= 0 AND compensation_attempts_done <= 3);

CREATE INDEX IF NOT EXISTS idx_risk_intercept_logs_compensation_due
  ON public.risk_intercept_logs (next_compensation_at ASC)
  WHERE status = 'retrying' AND auto_compensation_eligible = true;
