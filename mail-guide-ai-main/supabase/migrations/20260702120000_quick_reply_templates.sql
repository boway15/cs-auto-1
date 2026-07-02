-- Quick reply templates for manual workbench insert (separate from reply_templates auto-reply)

CREATE TABLE public.quick_reply_templates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT NOT NULL,
  body_template    TEXT NOT NULL,
  subject_template TEXT,
  category         TEXT,
  business_intents TEXT[] NOT NULL DEFAULT '{}',
  scope            TEXT NOT NULL CHECK (scope IN ('team', 'personal')),
  owner_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  sort_order       INT NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT quick_reply_personal_owner_chk CHECK (
    (scope = 'team' AND owner_id IS NULL) OR
    (scope = 'personal' AND owner_id IS NOT NULL)
  )
);

COMMENT ON TABLE public.quick_reply_templates IS
  'Workbench canned responses (team + personal); not used for automated reply_templates slots.';

CREATE INDEX idx_quick_reply_team ON public.quick_reply_templates (scope, is_active, sort_order)
  WHERE scope = 'team';
CREATE INDEX idx_quick_reply_personal ON public.quick_reply_templates (owner_id, is_active, sort_order)
  WHERE scope = 'personal';

CREATE TRIGGER trg_quick_reply_templates_updated
  BEFORE UPDATE ON public.quick_reply_templates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.quick_reply_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "员工可读快捷回复"
  ON public.quick_reply_templates FOR SELECT TO authenticated
  USING (
    public.is_staff(auth.uid()) AND (
      scope = 'team' OR owner_id = auth.uid()
    )
  );

CREATE POLICY "管理员管理团队快捷回复"
  ON public.quick_reply_templates FOR INSERT TO authenticated
  WITH CHECK (
    scope = 'team' AND public.has_role(auth.uid(), 'admin'::app_role)
  );

CREATE POLICY "管理员更新团队快捷回复"
  ON public.quick_reply_templates FOR UPDATE TO authenticated
  USING (scope = 'team' AND public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (scope = 'team' AND public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "管理员删除团队快捷回复"
  ON public.quick_reply_templates FOR DELETE TO authenticated
  USING (scope = 'team' AND public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "用户管理个人快捷回复"
  ON public.quick_reply_templates FOR ALL TO authenticated
  USING (scope = 'personal' AND owner_id = auth.uid())
  WITH CHECK (scope = 'personal' AND owner_id = auth.uid());

INSERT INTO public.quick_reply_templates (title, body_template, subject_template, category, business_intents, scope, sort_order)
SELECT * FROM (VALUES
  (
    '请提供订单号',
    E'您好 {{from_name}}，\n\n感谢来信。为尽快处理，请提供您的订单号。\n\n谢谢！',
    NULL::text,
    '缺信息',
    ARRAY['order_cancel', 'address_change', 'logistics']::text[],
    'team',
    10
  ),
  (
    '已安排发货说明',
    E'您好 {{from_name}}，\n\n您的订单 {{order_no}} 已安排发货，请留意物流更新。\n\n如有疑问欢迎随时联系我们。',
    NULL::text,
    '物流',
    ARRAY['logistics', 'delay_shipping']::text[],
    'team',
    20
  )
) AS v(title, body_template, subject_template, category, business_intents, scope, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.quick_reply_templates WHERE scope = 'team' LIMIT 1);
