-- 1. 启用扩展
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2. 创建附件存储桶（公开读，便于工作台直接预览）
INSERT INTO storage.buckets (id, name, public)
VALUES ('email-attachments', 'email-attachments', true)
ON CONFLICT (id) DO NOTHING;

-- 3. Storage 访问策略
DROP POLICY IF EXISTS "公开查看邮件附件" ON storage.objects;
CREATE POLICY "公开查看邮件附件"
ON storage.objects FOR SELECT
USING (bucket_id = 'email-attachments');

DROP POLICY IF EXISTS "员工可上传邮件附件" ON storage.objects;
CREATE POLICY "员工可上传邮件附件"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'email-attachments' AND public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "管理员可删除邮件附件" ON storage.objects;
CREATE POLICY "管理员可删除邮件附件"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'email-attachments' AND public.has_role(auth.uid(), 'admin'::app_role));