-- 后台正文补拉：每 3 分钟，与 sync-mailbox（*/4 整点）错开 1 分钟

SELECT cron.unschedule('email-body-repair-tasks-every-3min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-body-repair-tasks-every-3min');

SELECT cron.schedule(
  'email-body-repair-tasks-every-3min',
  '1-59/3 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://elchuqvftkhszbkwgfjp.supabase.co/functions/v1/run-email-body-repair-tasks',
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
