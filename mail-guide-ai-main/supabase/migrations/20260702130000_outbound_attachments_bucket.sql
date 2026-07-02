-- Outbound reply attachments (temporary upload before send-reply)

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'outbound-attachments',
  'outbound-attachments',
  false,
  10485760,
  ARRAY[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/png',
    'image/jpeg',
    'image/gif',
    'application/zip'
  ]::text[]
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "员工上传出站附件"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'outbound-attachments'
    AND public.is_staff(auth.uid())
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "员工读自己的出站附件"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'outbound-attachments'
    AND public.is_staff(auth.uid())
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "员工删自己的出站附件"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'outbound-attachments'
    AND public.is_staff(auth.uid())
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
