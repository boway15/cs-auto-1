-- 扩展 emails.business_intent：7 类 -> 10 类（渠道/咨询/会话收尾/接受方案）

ALTER TABLE public.emails
  DROP CONSTRAINT IF EXISTS emails_business_intent_chk;

ALTER TABLE public.emails
  ADD CONSTRAINT emails_business_intent_chk
  CHECK (business_intent IS NULL OR business_intent IN (
    'order_cancel',
    'address_change',
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
  '业务意图（10 类）：售后 order_cancel/address_change/damaged/defect/description_mismatch/logistics/other；渠道 amazon_marketplace；咨询 product_inquiry；会话 conversation_idle/solution_accepted。';
