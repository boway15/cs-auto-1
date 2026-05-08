
-- 辅助函数：是否为客服系统员工
CREATE OR REPLACE FUNCTION public.is_staff(_user_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role IN ('admin','leader','agent')
  )
$$;

-- 替换宽松策略
DROP POLICY "登录用户可创建邮件" ON public.emails;
DROP POLICY "登录用户可更新邮件" ON public.emails;
CREATE POLICY "员工可创建邮件" ON public.emails FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));
CREATE POLICY "员工可更新邮件" ON public.emails FOR UPDATE TO authenticated USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));

DROP POLICY "登录用户可写入订单" ON public.orders;
DROP POLICY "登录用户可更新订单" ON public.orders;
CREATE POLICY "员工可写入订单" ON public.orders FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));
CREATE POLICY "员工可更新订单" ON public.orders FOR UPDATE TO authenticated USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));

DROP POLICY "登录用户可创建关联" ON public.email_order_links;
DROP POLICY "登录用户可删除关联" ON public.email_order_links;
CREATE POLICY "员工可创建关联" ON public.email_order_links FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));
CREATE POLICY "员工可删除关联" ON public.email_order_links FOR DELETE TO authenticated USING (public.is_staff(auth.uid()));

DROP POLICY "登录用户可创建草稿" ON public.ai_drafts;
DROP POLICY "登录用户可更新草稿" ON public.ai_drafts;
CREATE POLICY "员工可创建草稿" ON public.ai_drafts FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));
CREATE POLICY "员工可更新草稿" ON public.ai_drafts FOR UPDATE TO authenticated USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));

DROP POLICY "本人可插入资料" ON public.profiles;
CREATE POLICY "本人可插入资料" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
