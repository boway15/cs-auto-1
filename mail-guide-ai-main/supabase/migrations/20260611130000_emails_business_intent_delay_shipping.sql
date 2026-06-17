-- 扩展 emails.business_intent：10 类 -> 11 类（延迟发货 delay_shipping）

ALTER TABLE public.emails
  DROP CONSTRAINT IF EXISTS emails_business_intent_chk;

ALTER TABLE public.emails
  ADD CONSTRAINT emails_business_intent_chk
  CHECK (business_intent IS NULL OR business_intent IN (
    'order_cancel',
    'address_change',
    'delay_shipping',
    'damaged',
    'defect',
    'description_mismatch',
    'logistics',
    'other',
    'amazon_marketplace',
    'product_inquiry',
    'conversation_idle',
    'solution_accepted'
  ));

COMMENT ON COLUMN public.emails.business_intent IS
  '业务意图（11 类）：售后 order_cancel/address_change/delay_shipping/damaged/defect/description_mismatch/logistics/other；渠道 amazon_marketplace；咨询 product_inquiry；会话 conversation_idle/solution_accepted。';

-- 缺单号自动回邮槽一：默认勾选延迟发货（与取消/改地址/物流同级 R1）
UPDATE public.reply_templates
SET enabled_business_intents = array_append(enabled_business_intents, 'delay_shipping')
WHERE trigger_type = 'ar_missing_order'
  AND NOT ('delay_shipping' = ANY(enabled_business_intents));
