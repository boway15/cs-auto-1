-- Store service role key in vault (idempotent)
DO $$
DECLARE
  v_key text;
BEGIN
  -- Read from existing vault entry if present, otherwise create placeholder
  SELECT decrypted_secret INTO v_key
  FROM vault.decrypted_secrets
  WHERE name = 'service_role_key'
  LIMIT 1;

  IF v_key IS NULL THEN
    -- Create empty placeholder; will be populated below using insert tool / settings
    PERFORM vault.create_secret('PLACEHOLDER', 'service_role_key', 'Service role key for cron-invoked edge functions');
  END IF;
END $$;

-- Re-schedule cron job to read from vault
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
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1)
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);