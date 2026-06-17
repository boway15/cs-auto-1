-- 扩展 business_intent：11 类 -> 12 类（发货前更换 SKU sku_change）
-- 自动拦截：按意图可配置 risk_auto_intercept_business_intents（总开关仍保留）

ALTER TABLE public.emails
  DROP CONSTRAINT IF EXISTS emails_business_intent_chk;

ALTER TABLE public.emails
  ADD CONSTRAINT emails_business_intent_chk
  CHECK (business_intent IS NULL OR business_intent IN (
    'order_cancel',
    'address_change',
    'delay_shipping',
    'sku_change',
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
  '业务意图（12 类）：售后 order_cancel/address_change/delay_shipping/sku_change/damaged/defect/description_mismatch/logistics/other；渠道 amazon_marketplace；咨询 product_inquiry；会话 conversation_idle/solution_accepted。';

ALTER TABLE public.automation_settings
  ADD COLUMN IF NOT EXISTS risk_auto_intercept_business_intents text[] NOT NULL
  DEFAULT ARRAY['order_cancel', 'address_change', 'delay_shipping']::text[];

COMMENT ON COLUMN public.automation_settings.risk_auto_intercept_business_intents IS
  '自动拦截适用的 business_intent 列表；仅 risk_auto_intercept_enabled=true 时生效；人工拦截不受限。';

UPDATE public.automation_settings
SET risk_auto_intercept_business_intents = ARRAY['order_cancel', 'address_change', 'delay_shipping']::text[]
WHERE singleton = 'default'
  AND cardinality(risk_auto_intercept_business_intents) = 0;
