-- 1. Shopify 店铺表
CREATE TABLE public.shopify_shops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_domain TEXT NOT NULL UNIQUE,
  display_name TEXT,
  access_token TEXT NOT NULL,
  api_version TEXT NOT NULL DEFAULT '2024-10',
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_synced_at TIMESTAMPTZ,
  last_sync_cursor TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.shopify_shops ENABLE ROW LEVEL SECURITY;

CREATE POLICY "管理员管理店铺" ON public.shopify_shops
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'))
  WITH CHECK (has_role(auth.uid(), 'admin'));

CREATE POLICY "员工可查看店铺" ON public.shopify_shops
  FOR SELECT TO authenticated
  USING (is_staff(auth.uid()));

CREATE TRIGGER update_shopify_shops_updated_at
  BEFORE UPDATE ON public.shopify_shops
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. 扩展 orders 表
ALTER TABLE public.orders
  ADD COLUMN shop_id UUID REFERENCES public.shopify_shops(id) ON DELETE SET NULL,
  ADD COLUMN shopify_order_id TEXT,
  ADD COLUMN shopify_order_gid TEXT,
  ADD COLUMN shipping_hold BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN hold_reason TEXT,
  ADD COLUMN hold_at TIMESTAMPTZ,
  ADD COLUMN hold_by UUID,
  ADD COLUMN shipping_address JSONB,
  ADD COLUMN fulfillment_status TEXT,
  ADD COLUMN financial_status TEXT,
  ADD COLUMN shopify_tags TEXT;

CREATE UNIQUE INDEX orders_shop_shopify_order_unique
  ON public.orders(shop_id, shopify_order_id)
  WHERE shopify_order_id IS NOT NULL;

CREATE INDEX orders_shop_id_idx ON public.orders(shop_id);
CREATE INDEX orders_shipping_hold_idx ON public.orders(shipping_hold) WHERE shipping_hold = true;

-- 3. 暂停发货操作历史表
CREATE TABLE public.order_hold_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  email_id UUID REFERENCES public.emails(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('hold', 'release')),
  reason TEXT,
  reason_category TEXT,
  shopify_synced BOOLEAN NOT NULL DEFAULT false,
  shopify_sync_error TEXT,
  performed_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.order_hold_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "登录用户可查看暂停日志" ON public.order_hold_logs
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "员工可创建暂停日志" ON public.order_hold_logs
  FOR INSERT TO authenticated
  WITH CHECK (is_staff(auth.uid()));

CREATE INDEX order_hold_logs_order_id_idx ON public.order_hold_logs(order_id);