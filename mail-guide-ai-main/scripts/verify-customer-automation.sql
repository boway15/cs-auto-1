-- 在 Supabase Dashboard → SQL Editor 中执行，用于核对客服自动化上线项

-- 1) 新列
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'emails'
  AND column_name IN ('ai_language', 'ai_sentiment');

-- 2) compensating 预警定时任务
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname = 'compensating-alerts-every-30min';

-- 3) 索引
SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'emails'
  AND indexname = 'idx_emails_compensating_received';

-- 4) 风控缺单号模板（启用前请在后台将 is_active、auto_send 按需打开）
SELECT id, name, trigger_type, is_active, auto_send
FROM public.reply_templates
WHERE trigger_type = 'risk_missing_order_no';

-- 5) vault（若 2) 无行或 net 请求失败，需检查 Dashboard → Project Settings → Vault 中 service_role_key）
-- SELECT name FROM vault.decrypted_secrets WHERE name = 'service_role_key';

-- 6) 手工调用 schedule-compensating-alerts（将 YOUR_SERVICE_ROLE 换为服务角色密钥）：
-- POST https://<project-ref>.supabase.co/functions/v1/schedule-compensating-alerts
-- Header: Authorization: Bearer YOUR_SERVICE_ROLE
-- Body: {}
