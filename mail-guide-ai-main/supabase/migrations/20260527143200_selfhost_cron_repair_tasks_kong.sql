-- 自建 Supabase：正文/附件补拉 cron 须走栈内 Kong，勿用 *.supabase.co。
-- 权威配置：mail-guide-ai-main/scripts/selfhosted/Apply-VaultAndCron.ps1
-- 本迁移在 db push 后若仍见云端 URL，请执行该脚本覆盖。

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('email-body-repair-tasks-every-3min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-body-repair-tasks-every-3min');

SELECT cron.schedule(
  'email-body-repair-tasks-every-3min',
  '1-59/3 * * * *',
  $$
  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/run-email-body-repair-tasks',
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

SELECT cron.unschedule('email-attachment-repair-tasks-every-5min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-attachment-repair-tasks-every-5min');

SELECT cron.schedule(
  'email-attachment-repair-tasks-every-5min',
  '2-59/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/run-email-attachment-repair-tasks',
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
