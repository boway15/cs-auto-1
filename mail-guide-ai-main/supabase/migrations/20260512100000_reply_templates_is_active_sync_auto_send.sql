-- 双槽自动回邮：发信端仅依据 auto_send；将 is_active 与 auto_send 对齐，避免历史数据分叉。
UPDATE public.reply_templates
SET is_active = auto_send
WHERE trigger_type IN ('ar_missing_order', 'ar_missing_order_or_attachment');

COMMENT ON COLUMN public.reply_templates.is_active IS
  '与 auto_send 保持同步（后台「自动回复」开关）；process-email 仅以 auto_send 为准。';
