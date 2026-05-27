-- 后台附件补拉：每 5 分钟，错峰于其他 cron 任务

SELECT cron.unschedule('email-attachment-repair-tasks-every-5min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-attachment-repair-tasks-every-5min');

SELECT cron.schedule(
  'email-attachment-repair-tasks-every-5min',
  '2-59/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://elchuqvftkhszbkwgfjp.supabase.co/functions/v1/run-email-attachment-repair-tasks',
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
