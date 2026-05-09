-- 有单号未关联（compensating）内部预警：收信满 2h 后由调度发告警邮件
-- 与 schedule-draft-generation 同周期

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('compensating-alerts-every-30min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'compensating-alerts-every-30min');

SELECT cron.schedule(
  'compensating-alerts-every-30min',
  '*/30 * * * *',
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
