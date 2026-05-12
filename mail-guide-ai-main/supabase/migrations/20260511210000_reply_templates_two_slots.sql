-- 双槽自动回邮：enabled_business_intents + 固定 trigger_type；关闭历史多模板自动发送

ALTER TABLE public.reply_templates
  ADD COLUMN IF NOT EXISTS enabled_business_intents text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN public.reply_templates.enabled_business_intents IS
  '自动回邮适用的 business_intent 列表；仅 ar_missing_order / ar_missing_order_or_attachment 两条槽使用';

-- 关闭非双槽模板的自动发送（保留历史行与 email_send_logs 外键）
UPDATE public.reply_templates
SET is_active = false, auto_send = false
WHERE trigger_type IS DISTINCT FROM 'ar_missing_order'
  AND trigger_type IS DISTINCT FROM 'ar_missing_order_or_attachment';

INSERT INTO public.reply_templates (
  name,
  trigger_type,
  subject_template,
  body_template,
  is_active,
  auto_send,
  variables,
  enabled_business_intents
)
SELECT
  '自动回复-缺失订单号',
  'ar_missing_order',
  'Re: {{subject}}',
  E'您好，\n\n请直接回复本邮件并提供您的订单号，以便我们为您处理。\n\n谢谢！\n客服团队',
  false,
  false,
  '["from_name","from_email","subject","order_no","missing_elements"]'::jsonb,
  ARRAY['order_cancel', 'address_change', 'logistics']::text[]
WHERE NOT EXISTS (SELECT 1 FROM public.reply_templates WHERE trigger_type = 'ar_missing_order');

INSERT INTO public.reply_templates (
  name,
  trigger_type,
  subject_template,
  body_template,
  is_active,
  auto_send,
  variables,
  enabled_business_intents
)
SELECT
  '自动回复-缺失订单号或附件',
  'ar_missing_order_or_attachment',
  'Re: {{subject}}',
  E'您好，\n\n为尽快处理，请在回复中补充您的订单号；如需举证请附上与问题相关的附件（任意格式均可）。\n\n谢谢！\n客服团队',
  false,
  false,
  '["from_name","from_email","subject","order_no","missing_elements"]'::jsonb,
  ARRAY['damaged', 'defect', 'description_mismatch']::text[]
WHERE NOT EXISTS (SELECT 1 FROM public.reply_templates WHERE trigger_type = 'ar_missing_order_or_attachment');

-- 已存在行时补齐默认意图（避免列新增后仍为空）
UPDATE public.reply_templates
SET enabled_business_intents = ARRAY['order_cancel', 'address_change', 'logistics']::text[]
WHERE trigger_type = 'ar_missing_order'
  AND (enabled_business_intents IS NULL OR cardinality(enabled_business_intents) = 0);

UPDATE public.reply_templates
SET enabled_business_intents = ARRAY['damaged', 'defect', 'description_mismatch']::text[]
WHERE trigger_type = 'ar_missing_order_or_attachment'
  AND (enabled_business_intents IS NULL OR cardinality(enabled_business_intents) = 0);
