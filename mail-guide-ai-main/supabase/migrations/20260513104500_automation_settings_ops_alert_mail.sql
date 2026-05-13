-- 运营告警邮件：可在 automation_settings 中配置（前端运营告警页）；未设置时仍使用 Edge 环境变量 ALERT_*。

ALTER TABLE public.automation_settings
  ADD COLUMN IF NOT EXISTS ops_alert_sender_email text,
  ADD COLUMN IF NOT EXISTS ops_alert_recipient_emails text;

COMMENT ON COLUMN public.automation_settings.ops_alert_sender_email IS
  '运营告警 SMTP 发件邮箱，须与 mailboxes.email_address 一致且该邮箱已配置 SMTP；NULL 表示使用环境变量 ALERT_SENDER_ADDRESS。';
COMMENT ON COLUMN public.automation_settings.ops_alert_recipient_emails IS
  '运营告警收件人，英文逗号或分号分隔多个邮箱；NULL 表示使用环境变量 ALERT_EMAIL_TO。';
