-- 1. Restrict mailboxes SELECT to admins only (passwords are stored here)
DROP POLICY IF EXISTS "登录用户可查看邮箱" ON public.mailboxes;
CREATE POLICY "管理员可查看邮箱"
ON public.mailboxes FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role));

-- 2. Restrict erp_configs SELECT to admins only (auth tokens are stored here)
DROP POLICY IF EXISTS "登录用户可查看ERP配置" ON public.erp_configs;
CREATE POLICY "管理员可查看ERP配置"
ON public.erp_configs FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role));

-- 3. Make email-attachments bucket private; replace public-read policy with auth-only
UPDATE storage.buckets SET public = false WHERE id = 'email-attachments';

DROP POLICY IF EXISTS "公开查看邮件附件" ON storage.objects;
CREATE POLICY "登录员工可查看邮件附件"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'email-attachments' AND public.is_staff(auth.uid()));