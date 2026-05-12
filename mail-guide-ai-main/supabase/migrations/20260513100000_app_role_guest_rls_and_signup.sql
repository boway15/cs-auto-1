-- 1) app_role 增加 guest：新用户（系统已有 admin）默认游客，无业务数据读权限
-- 2) 收紧若干 SELECT RLS：仅 is_staff（admin/leader/agent）可读任务与配置类数据

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'guest';

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)));

  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'admin') THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin');
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'guest');
  END IF;

  RETURN NEW;
END;
$$;

-- 业务与任务数据：仅员工可读
DROP POLICY IF EXISTS "登录用户可查看邮件" ON public.emails;
CREATE POLICY "员工可查看邮件"
  ON public.emails FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "登录用户可查看订单" ON public.orders;
CREATE POLICY "员工可查看订单"
  ON public.orders FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "登录用户可查看关联" ON public.email_order_links;
CREATE POLICY "员工可查看关联"
  ON public.email_order_links FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "登录用户可查看草稿" ON public.ai_drafts;
CREATE POLICY "员工可查看草稿"
  ON public.ai_drafts FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "登录用户可查看邮箱" ON public.mailboxes;
CREATE POLICY "员工可查看邮箱"
  ON public.mailboxes FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "登录用户可查看ERP配置" ON public.erp_configs;
CREATE POLICY "员工可查看ERP配置"
  ON public.erp_configs FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "登录用户可查看模板" ON public.reply_templates;
CREATE POLICY "员工可查看模板"
  ON public.reply_templates FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

-- 资料：本人或员工；角色：本人可读自己的角色，员工可读全员（便于管理）
DROP POLICY IF EXISTS "登录用户可查看所有资料" ON public.profiles;
CREATE POLICY "用户可查看资料"
  ON public.profiles FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "登录用户可查看角色" ON public.user_roles;
CREATE POLICY "用户可查看角色"
  ON public.user_roles FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "登录用户可查看发送日志" ON public.email_send_logs;
CREATE POLICY "员工可查看发送日志"
  ON public.email_send_logs FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "登录用户可查看暂停日志" ON public.order_hold_logs;
CREATE POLICY "员工可查看暂停日志"
  ON public.order_hold_logs FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "登录用户可读自动化配置" ON public.automation_settings;
CREATE POLICY "员工可读自动化配置"
  ON public.automation_settings FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));
