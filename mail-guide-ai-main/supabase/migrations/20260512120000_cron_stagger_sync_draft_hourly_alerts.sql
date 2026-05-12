-- 错峰定时：减轻同一时刻多任务叠加
-- - sync-mailbox：每 4 分钟，自整点 0 分起（0,4,8,...）
-- - schedule-draft-generation：每 4 分钟，自第 2 分起（2,6,10,...），与收信错开 2 分钟
-- - schedule-compensating-alerts：每小时第 15 分一次
-- jobname 保持历史名称，便于自建 Apply-VaultAndCron.ps1 覆盖

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('auto-sync-mailbox-every-5min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-sync-mailbox-every-5min');

SELECT cron.schedule(
  'auto-sync-mailbox-every-5min',
  '*/4 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://elchuqvftkhszbkwgfjp.supabase.co/functions/v1/sync-mailbox',
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

SELECT cron.unschedule('auto-draft-every-30min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-draft-every-30min');

SELECT cron.schedule(
  'auto-draft-every-30min',
  '2-59/4 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://elchuqvftkhszbkwgfjp.supabase.co/functions/v1/schedule-draft-generation',
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

SELECT cron.unschedule('compensating-alerts-every-30min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'compensating-alerts-every-30min');

SELECT cron.schedule(
  'compensating-alerts-every-30min',
  '15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://elchuqvftkhszbkwgfjp.supabase.co/functions/v1/schedule-compensating-alerts',
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
