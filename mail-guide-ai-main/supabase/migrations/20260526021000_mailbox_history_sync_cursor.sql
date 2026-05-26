ALTER TABLE public.mailboxes
  ADD COLUMN IF NOT EXISTS history_sync_cursor_uid bigint,
  ADD COLUMN IF NOT EXISTS history_sync_completed_at timestamptz;

COMMENT ON COLUMN public.mailboxes.history_sync_cursor_uid IS '历史邮件同步游标：按 UID 从新到旧分批回补时，下一批只处理小于该 UID 的邮件。';
COMMENT ON COLUMN public.mailboxes.history_sync_completed_at IS '最近 30 天历史邮件回补完成时间；新邮件增量仍由 last_uid 跟踪。';
