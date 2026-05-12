-- 关联状态新增 manual_unlink（人工解除）：不再走自动关联与补偿任务，仅人工再次关联后变为 linked。
ALTER TABLE public.emails
  DROP CONSTRAINT IF EXISTS emails_assoc_chk;
ALTER TABLE public.emails
  ADD CONSTRAINT emails_assoc_chk
  CHECK (association_status IN (
    'unlinked',
    'not_provided',
    'not_found',
    'compensating',
    'recommended',
    'linked',
    'manual_unlink'
  ));

COMMENT ON COLUMN public.emails.association_status IS
  '关联状态：linked 已关联；not_provided 未提供单号或补偿耗尽后视同未提供；compensating 已提供单号待匹配；manual_unlink 人工解除后仅支持人工再关联；not_found 历史/其它未命中；recommended 推荐态。';
