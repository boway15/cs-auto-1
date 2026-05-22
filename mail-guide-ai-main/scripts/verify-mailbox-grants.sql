-- 邮箱授权 + 权限闭环验收（Supabase SQL Editor 或 psql）
-- 前置：
--   20260522140000_user_mailbox_grants_rls.sql
--   20260522150000_mailbox_scope_closure.sql

-- 1) 表与函数存在
SELECT to_regclass('public.user_mailbox_grants') AS grants_table;
SELECT proname FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname IN (
      'can_access_mailbox',
      'can_access_email',
      'can_access_order',
      'list_accessible_mailboxes'
    )
  ORDER BY proname;

-- 2) 为测试用户授权（替换 UUID）
-- INSERT INTO public.user_mailbox_grants (user_id, mailbox_id)
-- VALUES ('<agent_user_id>', '<mailbox_id>')
-- ON CONFLICT DO NOTHING;

-- 3) 函数探测（替换 UUID）
-- SELECT public.can_access_mailbox('<agent_user_id>', '<mailbox_a>') AS ok_a;
-- SELECT public.can_access_mailbox('<agent_user_id>', '<mailbox_b>') AS ok_b;
-- SELECT public.can_access_email('<agent_user_id>', '<email_in_a>') AS ok_email;
-- SELECT public.can_access_order('<agent_user_id>', '<order_linked_to_a>') AS ok_order;
-- SELECT public.can_access_order('<agent_user_id>', '<order_not_linked>') AS deny_order;

-- 4) 以 agent JWT 在客户端验证
-- SELECT count(*) FROM public.emails;
-- SELECT * FROM public.list_accessible_mailboxes();
-- SELECT count(*) FROM public.email_send_logs;
-- SELECT count(*) FROM public.orders;
-- SELECT count(*) FROM public.order_hold_logs;

-- 5) email_send_logs：授权邮箱可见、未授权不可见（agent JWT）
-- SELECT id, email_id, mailbox_id FROM public.email_send_logs LIMIT 20;

-- 6) admin 可见双空历史发送日志（admin JWT）
-- SELECT count(*) FROM public.email_send_logs
--  WHERE email_id IS NULL AND mailbox_id IS NULL;

-- 7) storage 附件：路径 {mailbox_id}/{email_id}/filename
-- 授权路径应能 createSignedUrl；未授权路径应失败（客户端 storage API）

-- 8) mailboxes 原表：非 admin SELECT 应 0 行；admin 可读
-- SELECT count(*) FROM public.mailboxes;  -- admin JWT
-- SELECT count(*) FROM public.mailboxes;  -- agent JWT → 0

-- 9) Edge Function 越权（curl + agent JWT）
-- get-order-by-email 无 email_id → 403
-- get-order-by-email 未授权 email_id → 403
-- risk-intercept 裸 order_id 无 email_id（manual）→ 403
