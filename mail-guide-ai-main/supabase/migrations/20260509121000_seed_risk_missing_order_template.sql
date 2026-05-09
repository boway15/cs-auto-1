-- 可选：取消/改地址缺单号专用模板（默认关闭，管理员在后台启用 is_active + auto_send 后再生效）

INSERT INTO public.reply_templates (name, trigger_type, subject_template, body_template, is_active, auto_send)
SELECT
  '风控-缺订单号（启用 AUTO_REPLY_RISK_MISSING_ORDER_NO 后请在后台打开自动发送）',
  'risk_missing_order_no',
  'Re: {{subject}}',
  E'您好，\n\n为尽快处理您的取消或地址修改请求，请直接回复本邮件并提供您的订单号。\n\n谢谢！\n客服团队',
  false,
  false
WHERE NOT EXISTS (
  SELECT 1 FROM public.reply_templates WHERE trigger_type = 'risk_missing_order_no'
);
