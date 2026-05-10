-- 产品决策：工单完成态仅保留 replied；历史 closed 记录统一迁移为 replied。
-- processing_status 保留 closed 原值，供历史溯源；status 字段统一为 replied。

UPDATE public.emails
SET
  status = 'replied',
  processing_status = CASE
    WHEN processing_status = 'closed' THEN 'manual_closed'
    ELSE processing_status
  END
WHERE status = 'closed';

COMMENT ON COLUMN public.emails.status IS
  '工单状态：pending / processing / replied。completed/closed 仅为历史兼容，主流程不再写入。';
