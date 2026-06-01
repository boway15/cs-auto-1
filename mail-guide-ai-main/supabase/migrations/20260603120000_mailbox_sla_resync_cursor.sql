-- 12h SLA 补扫续扫 + 历史回补后台自动续跑标志

ALTER TABLE public.mailboxes
  ADD COLUMN IF NOT EXISTS sla_resync_scan_offset integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sla_resync_window_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS sla_resync_last_at timestamptz,
  ADD COLUMN IF NOT EXISTS history_backfill_auto_continue boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS history_backfill_last_at timestamptz;

COMMENT ON COLUMN public.mailboxes.sla_resync_scan_offset IS
  '12h SLA 补扫：当前滚动时间窗 UID 列表扫描下标（worker 续扫）。';
COMMENT ON COLUMN public.mailboxes.sla_resync_window_started_at IS
  '12h SLA 补扫：本轮滚动窗锚点；窗滚动时 reset offset。';
COMMENT ON COLUMN public.mailboxes.sla_resync_last_at IS
  '最近一次 run-sla-mailbox-sync worker 执行时间。';
COMMENT ON COLUMN public.mailboxes.history_backfill_auto_continue IS
  '为 true 时 run-mailbox-history-backfill 续跑 force_bulk 历史回补。';
COMMENT ON COLUMN public.mailboxes.history_backfill_last_at IS
  '最近一次后台历史回补 worker 执行时间。';
