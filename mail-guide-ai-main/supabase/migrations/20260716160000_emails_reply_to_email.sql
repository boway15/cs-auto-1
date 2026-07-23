-- 来信 Reply-To 头（平台代发时实际回复目标）；存量为空，发信时回退 from_email。
ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS reply_to_email TEXT;

COMMENT ON COLUMN public.emails.reply_to_email IS
  'MIME Reply-To 解析地址；为空时发信回退 from_email。';
