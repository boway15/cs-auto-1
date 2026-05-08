-- 修正 auto-sync-mailbox-every-5min 的函数 URL 指向当前项目 ref
-- 旧迁移里存在 bptbtasqchdfabpntxmi 的历史地址，这里统一切回 elchuqvftkhszbkwgfjp
-- 鉴权仍使用 vault 中的 service_role_key

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('auto-sync-mailbox-every-5min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-sync-mailbox-every-5min');

SELECT cron.schedule(
  'auto-sync-mailbox-every-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://elchuqvftkhszbkwgfjp.supabase.co/functions/v1/sync-mailbox',
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

