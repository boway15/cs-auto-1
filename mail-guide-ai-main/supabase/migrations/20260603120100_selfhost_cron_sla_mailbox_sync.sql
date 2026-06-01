-- 自建 Supabase：12h SLA 邮件补扫 cron（栈内 Kong）

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('run-sla-mailbox-sync-every-10min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'run-sla-mailbox-sync-every-10min');

SELECT cron.schedule(
  'run-sla-mailbox-sync-every-10min',
  '5,15,25,35,45,55 * * * *',
  $$
  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/run-sla-mailbox-sync',
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
