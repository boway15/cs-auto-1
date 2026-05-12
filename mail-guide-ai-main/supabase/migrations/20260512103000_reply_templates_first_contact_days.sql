-- 首封窗口改为按「双槽」reply_templates 各行配置（与 automation_settings 解耦；迁移时从全局表抄一次）

ALTER TABLE public.reply_templates
  ADD COLUMN IF NOT EXISTS auto_reply_first_contact_days integer;

UPDATE public.reply_templates rt
SET auto_reply_first_contact_days = COALESCE(
  (SELECT s.auto_reply_first_contact_days FROM public.automation_settings s WHERE s.singleton = 'default'),
  30
)
WHERE rt.trigger_type IN ('ar_missing_order', 'ar_missing_order_or_attachment')
  AND rt.auto_reply_first_contact_days IS NULL;

UPDATE public.reply_templates
SET auto_reply_first_contact_days = 30
WHERE auto_reply_first_contact_days IS NULL;

ALTER TABLE public.reply_templates
  ALTER COLUMN auto_reply_first_contact_days SET DEFAULT 30,
  ALTER COLUMN auto_reply_first_contact_days SET NOT NULL;

ALTER TABLE public.reply_templates DROP CONSTRAINT IF EXISTS reply_templates_first_contact_days_chk;
ALTER TABLE public.reply_templates
  ADD CONSTRAINT reply_templates_first_contact_days_chk CHECK (
    auto_reply_first_contact_days IN (0, 3, 7, 15, 30)
  );

COMMENT ON COLUMN public.reply_templates.auto_reply_first_contact_days IS
  '本模板要素缺失自动回复的首封窗口（天）：0=不限；3/7/15/30=近 N 天同发件人无其它邮件。process-email 按触发槽读取。';
