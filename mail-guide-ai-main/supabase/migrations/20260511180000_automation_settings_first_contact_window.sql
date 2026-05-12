-- 要素缺失自动回复：首封判定窗口（天）。0=不限首封；3/7/15/30=近 N 天同发件人无其它邮件。

CREATE TABLE public.automation_settings (
  singleton text PRIMARY KEY DEFAULT 'default'::text,
  auto_reply_first_contact_days integer NOT NULL DEFAULT 30,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_settings_singleton_key CHECK (singleton = 'default'),
  CONSTRAINT automation_settings_first_contact_days_chk CHECK (
    auto_reply_first_contact_days IN (0, 3, 7, 15, 30)
  )
);

COMMENT ON TABLE public.automation_settings IS '全局自动化配置（单行 default）';
COMMENT ON COLUMN public.automation_settings.auto_reply_first_contact_days IS
  '要素缺失自动回复首封窗口：0=不限，3/7/15/30=近 N 天同发件人无其它邮件';

INSERT INTO public.automation_settings (singleton, auto_reply_first_contact_days)
VALUES ('default', 30)
ON CONFLICT (singleton) DO NOTHING;

CREATE TRIGGER trg_automation_settings_updated
  BEFORE UPDATE ON public.automation_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.automation_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "登录用户可读自动化配置" ON public.automation_settings;
CREATE POLICY "登录用户可读自动化配置"
  ON public.automation_settings FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "管理员可管理自动化配置" ON public.automation_settings;
CREATE POLICY "管理员可管理自动化配置"
  ON public.automation_settings FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
