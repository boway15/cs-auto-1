-- 自建 Supabase：历史邮件后台回补 cron（栈内 Kong）

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('run-mailbox-history-backfill-every-5min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'run-mailbox-history-backfill-every-5min');

SELECT cron.schedule(
  'run-mailbox-history-backfill-every-5min',
  '8,18,28,38,48,58 * * * *',
  $$
  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/run-mailbox-history-backfill',
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
