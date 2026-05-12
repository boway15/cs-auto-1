-- PostgREST upsert（risk-intercept 使用 onConflict: idempotency_key）会生成
-- ON CONFLICT (idempotency_key)，无法匹配「部分唯一索引」
-- (WHERE idempotency_key IS NOT NULL)，导致 42P10。
-- 改为普通唯一索引：非空 idempotency_key 仍唯一；PostgreSQL 允许多行 idempotency_key IS NULL。

DROP INDEX IF EXISTS public.idx_risk_intercept_idempotency;

CREATE UNIQUE INDEX IF NOT EXISTS idx_risk_intercept_logs_idempotency_key_unique
  ON public.risk_intercept_logs (idempotency_key);
