-- 权限闭环：orders / order_hold_logs / email_send_logs / storage / mailboxes 安全入口

-- 订单：仅可访问与授权邮件存在关联的订单
CREATE OR REPLACE FUNCTION public.can_access_order(_user_id UUID, _order_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN _user_id IS NULL OR _order_id IS NULL THEN FALSE
    WHEN public.has_role(_user_id, 'admin') THEN TRUE
    ELSE EXISTS (
      SELECT 1 FROM public.email_order_links l
      WHERE l.order_id = _order_id
        AND public.can_access_email(_user_id, l.email_id)
    )
  END
$$;

COMMENT ON FUNCTION public.can_access_order IS 'admin 全量；leader/agent 仅可访问与授权邮件关联的订单';

-- 安全邮箱列表（不含 auth_password 等敏感字段）
CREATE OR REPLACE FUNCTION public.list_accessible_mailboxes()
RETURNS TABLE (
  id UUID,
  email_address TEXT,
  display_name TEXT,
  is_active BOOLEAN
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.id, m.email_address, m.display_name, m.is_active
  FROM public.mailboxes m
  WHERE m.is_active = true
    AND public.can_access_mailbox(auth.uid(), m.id)
  ORDER BY m.email_address
$$;

GRANT EXECUTE ON FUNCTION public.list_accessible_mailboxes() TO authenticated;

-- mailboxes：仅 admin 可读原表（含密码）
DROP POLICY IF EXISTS "员工可查看邮箱" ON public.mailboxes;
DROP POLICY IF EXISTS "登录用户可查看邮箱" ON public.mailboxes;
DROP POLICY IF EXISTS "管理员可查看邮箱" ON public.mailboxes;
CREATE POLICY "管理员可查看邮箱配置"
  ON public.mailboxes FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- orders
DROP POLICY IF EXISTS "员工可查看订单" ON public.orders;
DROP POLICY IF EXISTS "登录用户可查看订单" ON public.orders;
CREATE POLICY "员工可查看订单"
  ON public.orders FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()) AND public.can_access_order(auth.uid(), id));

DROP POLICY IF EXISTS "员工可写入订单" ON public.orders;
DROP POLICY IF EXISTS "登录用户可写入订单" ON public.orders;
CREATE POLICY "管理员可写入订单"
  ON public.orders FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "员工可更新订单" ON public.orders;
DROP POLICY IF EXISTS "登录用户可更新订单" ON public.orders;
CREATE POLICY "员工可更新订单"
  ON public.orders FOR UPDATE TO authenticated
  USING (public.is_staff(auth.uid()) AND public.can_access_order(auth.uid(), id))
  WITH CHECK (public.is_staff(auth.uid()) AND public.can_access_order(auth.uid(), id));

-- order_hold_logs
DROP POLICY IF EXISTS "员工可查看暂停日志" ON public.order_hold_logs;
DROP POLICY IF EXISTS "登录用户可查看暂停日志" ON public.order_hold_logs;
CREATE POLICY "员工可查看暂停日志"
  ON public.order_hold_logs FOR SELECT TO authenticated
  USING (
    public.is_staff(auth.uid())
    AND (
      email_id IS NOT NULL AND public.can_access_email(auth.uid(), email_id)
      OR order_id IS NOT NULL AND public.can_access_order(auth.uid(), order_id)
    )
  );

DROP POLICY IF EXISTS "员工可创建暂停日志" ON public.order_hold_logs;
DROP POLICY IF EXISTS "登录用户可创建暂停日志" ON public.order_hold_logs;
CREATE POLICY "员工可创建暂停日志"
  ON public.order_hold_logs FOR INSERT TO authenticated
  WITH CHECK (
    public.is_staff(auth.uid())
    AND (
      email_id IS NOT NULL AND public.can_access_email(auth.uid(), email_id)
      OR order_id IS NOT NULL AND public.can_access_order(auth.uid(), order_id)
    )
  );

-- email_send_logs：收紧 SELECT / INSERT / UPDATE
DROP POLICY IF EXISTS "员工可查看发送日志" ON public.email_send_logs;
DROP POLICY IF EXISTS "登录用户可查看发送日志" ON public.email_send_logs;
CREATE POLICY "员工可查看发送日志"
  ON public.email_send_logs FOR SELECT TO authenticated
  USING (
    public.is_staff(auth.uid())
    AND (
      public.has_role(auth.uid(), 'admin') AND email_id IS NULL AND mailbox_id IS NULL
      OR email_id IS NULL AND mailbox_id IS NOT NULL AND public.can_access_mailbox(auth.uid(), mailbox_id)
      OR email_id IS NOT NULL AND public.can_access_email(auth.uid(), email_id)
    )
  );

DROP POLICY IF EXISTS "员工可写入发送日志" ON public.email_send_logs;
DROP POLICY IF EXISTS "登录用户可写入发送日志" ON public.email_send_logs;
CREATE POLICY "员工可写入发送日志"
  ON public.email_send_logs FOR INSERT TO authenticated
  WITH CHECK (
    public.is_staff(auth.uid())
    AND (
      email_id IS NOT NULL AND public.can_access_email(auth.uid(), email_id)
      OR email_id IS NULL AND mailbox_id IS NOT NULL AND public.can_access_mailbox(auth.uid(), mailbox_id)
    )
  );

DROP POLICY IF EXISTS "员工可更新发送日志" ON public.email_send_logs;
CREATE POLICY "员工可更新发送日志"
  ON public.email_send_logs FOR UPDATE TO authenticated
  USING (
    public.is_staff(auth.uid())
    AND (
      email_id IS NOT NULL AND public.can_access_email(auth.uid(), email_id)
      OR email_id IS NULL AND mailbox_id IS NOT NULL AND public.can_access_mailbox(auth.uid(), mailbox_id)
      OR public.has_role(auth.uid(), 'admin') AND email_id IS NULL AND mailbox_id IS NULL
    )
  )
  WITH CHECK (
    public.is_staff(auth.uid())
    AND (
      email_id IS NOT NULL AND public.can_access_email(auth.uid(), email_id)
      OR email_id IS NULL AND mailbox_id IS NOT NULL AND public.can_access_mailbox(auth.uid(), mailbox_id)
      OR public.has_role(auth.uid(), 'admin') AND email_id IS NULL AND mailbox_id IS NULL
    )
  );

-- storage email-attachments：路径为 {mailbox_id}/{email_id}/...
DROP POLICY IF EXISTS "登录员工可查看邮件附件" ON storage.objects;
DROP POLICY IF EXISTS "公开查看邮件附件" ON storage.objects;
DROP POLICY IF EXISTS "员工可查看邮件附件" ON storage.objects;
DROP POLICY IF EXISTS "员工可上传邮件附件" ON storage.objects;
DROP POLICY IF EXISTS "员工可上传邮件附件" ON storage.objects;

CREATE POLICY "员工可查看邮件附件"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'email-attachments'
    AND public.is_staff(auth.uid())
    AND (storage.foldername(name))[1] IS NOT NULL
    AND (storage.foldername(name))[2] IS NOT NULL
    AND public.can_access_mailbox(auth.uid(), ((storage.foldername(name))[1])::uuid)
    AND public.can_access_email(auth.uid(), ((storage.foldername(name))[2])::uuid)
  );

CREATE POLICY "员工可上传邮件附件"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'email-attachments'
    AND public.is_staff(auth.uid())
    AND (storage.foldername(name))[1] IS NOT NULL
    AND (storage.foldername(name))[2] IS NOT NULL
    AND public.can_access_mailbox(auth.uid(), ((storage.foldername(name))[1])::uuid)
    AND public.can_access_email(auth.uid(), ((storage.foldername(name))[2])::uuid)
  );

CREATE POLICY "员工可更新邮件附件"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'email-attachments'
    AND public.is_staff(auth.uid())
    AND (storage.foldername(name))[1] IS NOT NULL
    AND (storage.foldername(name))[2] IS NOT NULL
    AND public.can_access_mailbox(auth.uid(), ((storage.foldername(name))[1])::uuid)
    AND public.can_access_email(auth.uid(), ((storage.foldername(name))[2])::uuid)
  );

CREATE POLICY "员工可删除邮件附件"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'email-attachments'
    AND public.is_staff(auth.uid())
    AND (storage.foldername(name))[1] IS NOT NULL
    AND (storage.foldername(name))[2] IS NOT NULL
    AND public.can_access_mailbox(auth.uid(), ((storage.foldername(name))[1])::uuid)
    AND public.can_access_email(auth.uid(), ((storage.foldername(name))[2])::uuid)
  );
