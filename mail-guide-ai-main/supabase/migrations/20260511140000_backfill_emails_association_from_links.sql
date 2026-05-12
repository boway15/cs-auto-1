-- 已有 email_order_links 但 emails.association_status 仍为默认/未命中展示时，回写为 linked（修复历史数据与人工仅写链接未改状态的情况）。
UPDATE public.emails e
SET association_status = 'linked'
WHERE EXISTS (SELECT 1 FROM public.email_order_links l WHERE l.email_id = e.id)
  AND e.association_status IN ('unlinked', 'not_provided', 'recommended', 'compensating');
