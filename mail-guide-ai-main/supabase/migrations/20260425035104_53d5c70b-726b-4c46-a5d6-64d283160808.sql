
-- 角色枚举
CREATE TYPE public.app_role AS ENUM ('admin', 'leader', 'agent');

-- profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- user_roles
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- has_role 安全函数
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- 邮箱配置
CREATE TABLE public.mailboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_address TEXT NOT NULL UNIQUE,
  display_name TEXT,
  protocol TEXT NOT NULL DEFAULT 'IMAP', -- IMAP / POP3
  incoming_host TEXT NOT NULL,
  incoming_port INT NOT NULL DEFAULT 993,
  use_ssl BOOLEAN NOT NULL DEFAULT true,
  auth_user TEXT NOT NULL,
  auth_password TEXT NOT NULL, -- 授权码（生产环境应加密/Vault）
  smtp_host TEXT,
  smtp_port INT DEFAULT 465,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.mailboxes ENABLE ROW LEVEL SECURITY;

-- 邮件
CREATE TABLE public.emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id UUID REFERENCES public.mailboxes(id) ON DELETE SET NULL,
  message_id TEXT UNIQUE,
  from_email TEXT NOT NULL,
  from_name TEXT,
  to_email TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  has_attachment BOOLEAN NOT NULL DEFAULT false,
  attachments JSONB DEFAULT '[]'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_read BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'pending', -- pending / processing / replied / closed
  category TEXT, -- 售前 / 售后 / 物流 / 退款 等（AI 分类）
  intent TEXT,
  missing_elements JSONB DEFAULT '[]'::jsonb, -- ['order_no','image']
  assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.emails ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_emails_status ON public.emails(status);
CREATE INDEX idx_emails_received ON public.emails(received_at DESC);

-- ERP 配置
CREATE TABLE public.erp_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'bearer', -- bearer / apikey / basic
  auth_token TEXT,
  order_endpoint TEXT NOT NULL DEFAULT '/orders',
  field_mapping JSONB NOT NULL DEFAULT '{}'::jsonb, -- {order_no:"orderNumber", customer_email:"email"...}
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.erp_configs ENABLE ROW LEVEL SECURITY;

-- 订单缓存
CREATE TABLE public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  erp_config_id UUID REFERENCES public.erp_configs(id) ON DELETE SET NULL,
  order_no TEXT NOT NULL,
  customer_email TEXT,
  customer_name TEXT,
  product_summary TEXT,
  shipping_status TEXT,
  tracking_no TEXT,
  order_status TEXT,
  amount NUMERIC,
  currency TEXT,
  raw_data JSONB,
  ordered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(erp_config_id, order_no)
);
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_orders_email ON public.orders(customer_email);
CREATE INDEX idx_orders_no ON public.orders(order_no);

-- 邮件-订单关联
CREATE TABLE public.email_order_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id UUID NOT NULL REFERENCES public.emails(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  link_source TEXT NOT NULL DEFAULT 'auto', -- auto / manual
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(email_id, order_id)
);
ALTER TABLE public.email_order_links ENABLE ROW LEVEL SECURITY;

-- AI 草稿
CREATE TABLE public.ai_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id UUID NOT NULL REFERENCES public.emails(id) ON DELETE CASCADE,
  version INT NOT NULL DEFAULT 1,
  guidance TEXT, -- 人工指导思想
  draft_content TEXT NOT NULL,
  model TEXT,
  generated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  is_used BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_drafts ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_ai_drafts_email ON public.ai_drafts(email_id, version DESC);

-- 自动回复模板（要素缺失）
CREATE TABLE public.reply_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL, -- missing_order_no / missing_image / missing_product
  subject_template TEXT,
  body_template TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.reply_templates ENABLE ROW LEVEL SECURITY;

-- 时间戳触发器
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_mailboxes_updated BEFORE UPDATE ON public.mailboxes FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_emails_updated BEFORE UPDATE ON public.emails FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_erp_updated BEFORE UPDATE ON public.erp_configs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_templates_updated BEFORE UPDATE ON public.reply_templates FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 新用户注册：自动建 profile，第一个用户给 admin，否则给 agent
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  user_count INT;
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)));

  SELECT COUNT(*) INTO user_count FROM auth.users;

  IF user_count = 1 THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin');
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'agent');
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ===== RLS Policies =====
-- profiles：所有登录用户可读，本人可改
CREATE POLICY "登录用户可查看所有资料" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "本人可更新资料" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "本人可插入资料" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- user_roles：登录用户可读，仅管理员可改
CREATE POLICY "登录用户可查看角色" ON public.user_roles FOR SELECT TO authenticated USING (true);
CREATE POLICY "管理员管理角色" ON public.user_roles FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- mailboxes
CREATE POLICY "登录用户可查看邮箱" ON public.mailboxes FOR SELECT TO authenticated USING (true);
CREATE POLICY "管理员管理邮箱" ON public.mailboxes FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- emails：登录用户可读、可更新（处理状态、分配等）
CREATE POLICY "登录用户可查看邮件" ON public.emails FOR SELECT TO authenticated USING (true);
CREATE POLICY "登录用户可创建邮件" ON public.emails FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "登录用户可更新邮件" ON public.emails FOR UPDATE TO authenticated USING (true);
CREATE POLICY "管理员可删除邮件" ON public.emails FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- erp_configs
CREATE POLICY "登录用户可查看ERP配置" ON public.erp_configs FOR SELECT TO authenticated USING (true);
CREATE POLICY "管理员管理ERP配置" ON public.erp_configs FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- orders
CREATE POLICY "登录用户可查看订单" ON public.orders FOR SELECT TO authenticated USING (true);
CREATE POLICY "登录用户可写入订单" ON public.orders FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "登录用户可更新订单" ON public.orders FOR UPDATE TO authenticated USING (true);

-- email_order_links
CREATE POLICY "登录用户可查看关联" ON public.email_order_links FOR SELECT TO authenticated USING (true);
CREATE POLICY "登录用户可创建关联" ON public.email_order_links FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "登录用户可删除关联" ON public.email_order_links FOR DELETE TO authenticated USING (true);

-- ai_drafts
CREATE POLICY "登录用户可查看草稿" ON public.ai_drafts FOR SELECT TO authenticated USING (true);
CREATE POLICY "登录用户可创建草稿" ON public.ai_drafts FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "登录用户可更新草稿" ON public.ai_drafts FOR UPDATE TO authenticated USING (true);

-- reply_templates
CREATE POLICY "登录用户可查看模板" ON public.reply_templates FOR SELECT TO authenticated USING (true);
CREATE POLICY "管理员管理模板" ON public.reply_templates FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
