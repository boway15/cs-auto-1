-- Phase A-1: emails 表新增业务意图、人工结案、SLA 桶字段，并加 CHECK 约束
-- 业务口径：
--   * business_intent  7 类业务意图（唯一枚举 + 单选 + 可人工修改）
--   * intent_legacy    旧 Dify/本地 intent 过渡期保留
--   * status=closed    人工结案（已处理）；与 replied 自动结案区分
--   * sla_bucket       SLA 时效分桶；仅对 pending/processing 生效，由调度任务按 received_at 计算

ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS business_intent text,
  ADD COLUMN IF NOT EXISTS intent_legacy text,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sla_bucket text;

ALTER TABLE public.emails
  DROP CONSTRAINT IF EXISTS emails_business_intent_chk;
ALTER TABLE public.emails
  ADD CONSTRAINT emails_business_intent_chk
  CHECK (business_intent IS NULL OR business_intent IN (
    'order_cancel','address_change','damaged','defect','description_mismatch','logistics','other'
  ));

ALTER TABLE public.emails
  DROP CONSTRAINT IF EXISTS emails_status_chk;
ALTER TABLE public.emails
  ADD CONSTRAINT emails_status_chk
  CHECK (status IN ('pending','processing','replied','closed'));

ALTER TABLE public.emails
  DROP CONSTRAINT IF EXISTS emails_assoc_chk;
ALTER TABLE public.emails
  ADD CONSTRAINT emails_assoc_chk
  CHECK (association_status IN ('unlinked','not_provided','not_found','compensating','recommended','linked'));

ALTER TABLE public.emails
  DROP CONSTRAINT IF EXISTS emails_sla_bucket_chk;
ALTER TABLE public.emails
  ADD CONSTRAINT emails_sla_bucket_chk
  CHECK (sla_bucket IS NULL OR sla_bucket IN ('within_24h','within_48h','within_72h','over_72h'));

CREATE INDEX IF NOT EXISTS idx_emails_business_intent ON public.emails(business_intent);
CREATE INDEX IF NOT EXISTS idx_emails_sla_bucket ON public.emails(sla_bucket) WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS idx_emails_closed_at ON public.emails(closed_at DESC) WHERE status = 'closed';

COMMENT ON COLUMN public.emails.business_intent IS
  '业务意图（7 类唯一枚举）：order_cancel/address_change/damaged/defect/description_mismatch/logistics/other；过渡期与 intent 并存。';
COMMENT ON COLUMN public.emails.intent_legacy IS
  '旧 intent 字段快照（来自 Dify/本地分析），仅用于过渡期对照展示。';
COMMENT ON COLUMN public.emails.status IS
  '工单状态：pending/processing 为流转中；replied 为系统发信后自动结案；closed 为人工结案（已处理）。';
COMMENT ON COLUMN public.emails.closed_at IS '人工结案时间（status=closed 时填充）。';
COMMENT ON COLUMN public.emails.closed_by IS '人工结案操作人（auth.users.id）。';
COMMENT ON COLUMN public.emails.sla_bucket IS
  'SLA 时效分桶：within_24h/within_48h/within_72h/over_72h；仅对 status in (pending,processing) 有意义；按 received_at 固定时钟、不考虑节假日时区。';
