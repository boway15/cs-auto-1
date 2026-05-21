-- 移除「retrying 超 4h 强制 failed」策略后，更新列注释（列保留供审计）

COMMENT ON COLUMN public.risk_intercept_logs.retrying_started_at IS
  '自动拦截首次进入 status=retrying 且可补偿时写入；终态由补偿次数上限（20）或邮件 12h 发件窗决定，不再单独按本字段超时。';
