-- 自动草稿调度任务：每 30 分钟触发 schedule-draft-generation Edge Function
-- 项目 ref：elchuqvftkhszbkwgfjp（与 supabase/config.toml 一致）
-- 鉴权：从 vault.decrypted_secrets 读取 service_role_key

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('auto-draft-every-30min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-draft-every-30min');

SELECT cron.schedule(
  'auto-draft-every-30min',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://elchuqvftkhszbkwgfjp.supabase.co/functions/v1/schedule-draft-generation',
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
