-- 迅捷回邮：新增 PO BOX 场景模板

ALTER TABLE public.erp_notify_templates
  DROP CONSTRAINT IF EXISTS erp_notify_templates_code_chk;

ALTER TABLE public.erp_notify_templates
  ADD CONSTRAINT erp_notify_templates_code_chk CHECK (
    template_code IN ('risk_shopify', 'risk_payoneer', 'risk_qty_ge_4', 'po_box')
  );

COMMENT ON TABLE public.erp_notify_templates IS 'ERP 订单拦截客户通知：固定场景模板';

INSERT INTO public.erp_notify_templates (template_code, name, subject_template, body_template, is_active)
VALUES (
  'po_box',
  'PO BOX 拦截通知',
  'Regarding your order {{order_no}}',
  E'Hello,\n\nYour order {{order_no}} requires additional shipping address verification because a PO Box was detected.\n\nPlease reply with a physical street address so we can proceed with shipment.\n\nThank you.',
  true
)
ON CONFLICT (template_code) DO NOTHING;
