-- R1/R2 自动回邮：合并索要单号+附件、仅缺附件；默认关闭 auto_send，由管理员在后台启用

INSERT INTO public.reply_templates (name, trigger_type, subject_template, body_template, is_active, auto_send)
SELECT
  '缺单号且缺附件（合并一封）',
  'missing_order_or_attachment_merged',
  'Re: {{subject}}',
  E'您好，\n\n为尽快处理您的问题，请在回复中补充：\n1）您的订单号；\n2）与问题相关的附件（任意格式均可）。\n\n谢谢配合！\n客服团队',
  false,
  false
WHERE NOT EXISTS (
  SELECT 1 FROM public.reply_templates WHERE trigger_type = 'missing_order_or_attachment_merged'
);

INSERT INTO public.reply_templates (name, trigger_type, subject_template, body_template, is_active, auto_send)
SELECT
  '缺附件（任意附件）',
  'missing_attachment',
  'Re: {{subject}}',
  E'您好，\n\n为便于我们核实情况，请回复本邮件并附上与问题相关的附件（任意格式均可）。\n\n谢谢！\n客服团队',
  false,
  false
WHERE NOT EXISTS (
  SELECT 1 FROM public.reply_templates WHERE trigger_type = 'missing_attachment'
);
