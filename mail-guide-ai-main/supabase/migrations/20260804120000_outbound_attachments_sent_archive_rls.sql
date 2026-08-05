-- 发送成功后出站附件归档路径：sent/{mailbox_id}/{send_log_id}/...
-- 允许能访问该邮箱的员工在发送日志详情中签名预览/下载
-- 注意：自建环境.objects 属主常为 supabase_storage_admin；勿对 policy 做 COMMENT（postgres 会报 must be owner）

DROP POLICY IF EXISTS "员工可读已发送出站附件归档" ON storage.objects;

CREATE POLICY "员工可读已发送出站附件归档"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'outbound-attachments'
    AND public.is_staff(auth.uid())
    AND (storage.foldername(name))[1] = 'sent'
    AND (storage.foldername(name))[2] IS NOT NULL
    AND public.can_access_mailbox(
      auth.uid(),
      ((storage.foldername(name))[2])::uuid
    )
  );
