-- ERP 拦截通知：独立站站点与发件邮箱关联

CREATE TABLE IF NOT EXISTS public.erp_site_mailboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_code text NOT NULL UNIQUE,
  site_name text NOT NULL DEFAULT '',
  sender_email text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.erp_site_mailboxes IS 'ERP 拦截通知：站点编码与发件邮箱（1 站点 1 邮箱）';
COMMENT ON COLUMN public.erp_site_mailboxes.site_code IS 'ERP 传入的站点编码，与 erp-notify-customer 请求 site_code 一致';
COMMENT ON COLUMN public.erp_site_mailboxes.site_name IS '站点展示名，用于模板 {{site_name}}';
COMMENT ON COLUMN public.erp_site_mailboxes.sender_email IS '发件邮箱，须与 mailboxes.email_address 一致且已配置 SMTP';

CREATE TRIGGER trg_erp_site_mailboxes_updated
  BEFORE UPDATE ON public.erp_site_mailboxes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.erp_site_mailboxes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "员工可查看ERP站点邮箱"
  ON public.erp_site_mailboxes FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

CREATE POLICY "管理员管理ERP站点邮箱"
  ON public.erp_site_mailboxes FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

UPDATE public.erp_notify_templates
SET variables = '["order_no","item_count","site_code","site_name"]'::jsonb
WHERE variables = '["order_no"]'::jsonb
   OR variables = '["order_no","item_count"]'::jsonb;
