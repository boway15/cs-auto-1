-- 自建 Supabase：邮件拉取任务 cron（栈内 Kong）

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('email-fetch-tasks-every-3min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-fetch-tasks-every-3min');

SELECT cron.schedule(
  'email-fetch-tasks-every-3min',
  '3-59/3 * * * *',
  $$
  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/run-email-fetch-tasks',
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
