-- ERP 拦截客户通知模板 + 邮箱签名

CREATE TABLE IF NOT EXISTS public.erp_notify_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_code text NOT NULL UNIQUE,
  name text NOT NULL,
  subject_template text NOT NULL DEFAULT '',
  body_template text NOT NULL DEFAULT '',
  sender_email text,
  is_active boolean NOT NULL DEFAULT true,
  variables jsonb NOT NULL DEFAULT '["order_no"]'::jsonb,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT erp_notify_templates_code_chk CHECK (
    template_code IN ('risk_shopify', 'risk_payoneer', 'risk_qty_ge_4')
  )
);

COMMENT ON TABLE public.erp_notify_templates IS 'ERP 订单拦截客户通知：固定三场景模板';
COMMENT ON COLUMN public.erp_notify_templates.sender_email IS '发件邮箱，须与 mailboxes.email_address 一致且已配置 SMTP';

ALTER TABLE public.mailboxes
  ADD COLUMN IF NOT EXISTS signature_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS signature_text text;

COMMENT ON COLUMN public.mailboxes.signature_enabled IS '发信时是否在正文末尾追加签名';
COMMENT ON COLUMN public.mailboxes.signature_text IS '纯文本签名内容';

CREATE TRIGGER trg_erp_notify_templates_updated
  BEFORE UPDATE ON public.erp_notify_templates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.erp_notify_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "员工可查看ERP通知模板"
  ON public.erp_notify_templates FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

CREATE POLICY "管理员管理ERP通知模板"
  ON public.erp_notify_templates FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

INSERT INTO public.erp_notify_templates (template_code, name, subject_template, body_template, is_active)
VALUES
  (
    'risk_shopify',
    'Shopify 风控拦截通知',
    'Regarding your order {{order_no}}',
    E'Hello,\n\nWe noticed a risk review on your Shopify order {{order_no}}. Shipment is temporarily on hold while we verify the details.\n\nIf you have questions, please reply to this email.\n\nThank you.',
    true
  ),
  (
    'risk_payoneer',
    'Payoneer 风控拦截通知',
    'Regarding your order {{order_no}}',
    E'Hello,\n\nYour order {{order_no}} is temporarily on hold due to a Payoneer risk notification we received.\n\nWe will follow up once the review is complete.\n\nThank you.',
    true
  ),
  (
    'risk_qty_ge_4',
    '购买数量≥4拦截通知',
    'Regarding your order {{order_no}}',
    E'Hello,\n\nYour order {{order_no}} has been temporarily held because the purchase quantity meets our review threshold (4 or more units in a single order).\n\nWe will contact you if we need any further information.\n\nThank you.',
    true
  )
ON CONFLICT (template_code) DO NOTHING;
