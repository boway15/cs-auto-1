DO $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = 'service_role_key';
  IF v_id IS NOT NULL THEN
    PERFORM vault.update_secret(v_id, 'eyJhbGciOiJIUzI1NiIsImtpZCI6IkdwY3FlMmIxRzdkLzhRSFEiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJwdGJ0YXNxY2hkZmFicG50eG1pIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzA2MjUyNiwiZXhwIjoyMDkyNjM4NTI2fQ.placeholder', 'service_role_key', 'Service role key for cron-invoked edge functions');
  END IF;
END $$;