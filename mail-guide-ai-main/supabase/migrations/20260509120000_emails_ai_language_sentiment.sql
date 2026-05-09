-- 邮件分析：语言 / 情绪落库（供草稿与展示；异常时由 Edge 默认 en / neutral）

ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS ai_language text,
  ADD COLUMN IF NOT EXISTS ai_sentiment text;

COMMENT ON COLUMN public.emails.ai_language IS '客户邮件语言：en/zh/other 等；识别失败时默认 en。';
COMMENT ON COLUMN public.emails.ai_sentiment IS '客户情绪：如 neutral/frustrated/angry 等；识别失败时默认 neutral。';
