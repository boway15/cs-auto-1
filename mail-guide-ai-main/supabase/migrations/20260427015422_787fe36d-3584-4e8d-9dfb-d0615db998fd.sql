-- Recreate cron job so it passes the service role key as Bearer token
SELECT cron.unschedule('auto-sync-mailbox-every-5min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-sync-mailbox-every-5min');

SELECT cron.schedule(
  'auto-sync-mailbox-every-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://bptbtasqchdfabpntxmi.supabase.co/functions/v1/sync-mailbox',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);