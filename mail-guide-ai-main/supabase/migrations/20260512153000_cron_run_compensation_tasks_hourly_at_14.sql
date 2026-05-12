-- 订单补偿任务调度：由每 30 分钟改为每小时第 14 分（与 Edge 内 next_run_at +1h 步长一致）
-- 自建环境仍以 Apply-VaultAndCron.ps1 覆盖 URL 为栈内 Kong

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('run-compensation-tasks-every-30min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'run-compensation-tasks-every-30min');

SELECT cron.schedule(
  'run-compensation-tasks-every-30min',
  '14 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://elchuqvftkhszbkwgfjp.supabase.co/functions/v1/run-compensation-tasks',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'service_role_key' LIMIT 1
      )
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
