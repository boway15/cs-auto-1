-- 拦截与本地订单解耦：凭邮件单号 hold 时无 order_id，用 referenced_order_no 记录 ERP 所用单号并便于检索
ALTER TABLE public.risk_intercept_logs
  ADD COLUMN IF NOT EXISTS referenced_order_no text;

COMMENT ON COLUMN public.risk_intercept_logs.referenced_order_no IS
  '本次拦截请求使用的订单号（ERP）；有本地 orders 时与 order 行一致，仅邮件单号拦截时 order_id 为空仅填此列。';
