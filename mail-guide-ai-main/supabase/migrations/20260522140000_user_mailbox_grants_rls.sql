-- 用户 ↔ 邮箱授权：admin 全局；leader/agent 仅可访问授权邮箱邮件
-- 配合 can_access_mailbox / can_access_email 收紧 RLS 与 Edge Functions 校验

CREATE TABLE IF NOT EXISTS public.user_mailbox_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mailbox_id UUID NOT NULL REFERENCES public.mailboxes(id) ON DELETE CASCADE,
  granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, mailbox_id)
);

CREATE INDEX IF NOT EXISTS idx_user_mailbox_grants_user ON public.user_mailbox_grants(user_id);
CREATE INDEX IF NOT EXISTS idx_user_mailbox_grants_mailbox ON public.user_mailbox_grants(mailbox_id);

ALTER TABLE public.user_mailbox_grants ENABLE ROW LEVEL SECURITY;

-- admin 可访问全部邮箱；leader/agent 需命中授权；guest 拒绝
-- mailbox_id IS NULL 的历史邮件仅 admin 可见
CREATE OR REPLACE FUNCTION public.can_access_mailbox(_user_id UUID, _mailbox_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN _user_id IS NULL THEN FALSE
    WHEN public.has_role(_user_id, 'admin') THEN TRUE
    WHEN _mailbox_id IS NULL THEN FALSE
    WHEN public.has_role(_user_id, 'leader') OR public.has_role(_user_id, 'agent') THEN EXISTS (
      SELECT 1 FROM public.user_mailbox_grants g
      WHERE g.user_id = _user_id AND g.mailbox_id = _mailbox_id
    )
    ELSE FALSE
  END
$$;

CREATE OR REPLACE FUNCTION public.can_access_email(_user_id UUID, _email_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN _user_id IS NULL OR _email_id IS NULL THEN FALSE
    WHEN public.has_role(_user_id, 'admin') THEN TRUE
    ELSE EXISTS (
      SELECT 1 FROM public.emails e
      WHERE e.id = _email_id
        AND (
          (e.mailbox_id IS NOT NULL AND public.can_access_mailbox(_user_id, e.mailbox_id))
        )
    )
  END
$$;

COMMENT ON TABLE public.user_mailbox_grants IS '客服/组长可访问的邮箱授权；admin 不依赖此表';
COMMENT ON FUNCTION public.can_access_mailbox IS 'admin 全量；leader/agent 按授权；null mailbox 仅 admin';
COMMENT ON FUNCTION public.can_access_email IS '通过 emails.mailbox_id 判断邮件是否可访问';

-- user_mailbox_grants 策略
DROP POLICY IF EXISTS "用户可查看本人邮箱授权" ON public.user_mailbox_grants;
CREATE POLICY "用户可查看本人邮箱授权"
  ON public.user_mailbox_grants FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "管理员管理邮箱授权" ON public.user_mailbox_grants;
CREATE POLICY "管理员管理邮箱授权"
  ON public.user_mailbox_grants FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- emails
DROP POLICY IF EXISTS "员工可查看邮件" ON public.emails;
CREATE POLICY "员工可查看邮件"
  ON public.emails FOR SELECT TO authenticated
  USING (
    public.is_staff(auth.uid())
    AND public.can_access_mailbox(auth.uid(), mailbox_id)
  );

DROP POLICY IF EXISTS "员工可创建邮件" ON public.emails;
CREATE POLICY "员工可创建邮件"
  ON public.emails FOR INSERT TO authenticated
  WITH CHECK (
    public.is_staff(auth.uid())
    AND public.can_access_mailbox(auth.uid(), mailbox_id)
  );

DROP POLICY IF EXISTS "员工可更新邮件" ON public.emails;
CREATE POLICY "员工可更新邮件"
  ON public.emails FOR UPDATE TO authenticated
  USING (
    public.is_staff(auth.uid())
    AND public.can_access_mailbox(auth.uid(), mailbox_id)
  )
  WITH CHECK (
    public.is_staff(auth.uid())
    AND public.can_access_mailbox(auth.uid(), mailbox_id)
  );

-- mailboxes SELECT
DROP POLICY IF EXISTS "员工可查看邮箱" ON public.mailboxes;
CREATE POLICY "员工可查看邮箱"
  ON public.mailboxes FOR SELECT TO authenticated
  USING (
    public.is_staff(auth.uid())
    AND public.can_access_mailbox(auth.uid(), id)
  );

-- email_order_links
DROP POLICY IF EXISTS "员工可查看关联" ON public.email_order_links;
CREATE POLICY "员工可查看关联"
  ON public.email_order_links FOR SELECT TO authenticated
  USING (public.can_access_email(auth.uid(), email_id));

DROP POLICY IF EXISTS "员工可创建关联" ON public.email_order_links;
CREATE POLICY "员工可创建关联"
  ON public.email_order_links FOR INSERT TO authenticated
  WITH CHECK (public.can_access_email(auth.uid(), email_id));

DROP POLICY IF EXISTS "员工可删除关联" ON public.email_order_links;
CREATE POLICY "员工可删除关联"
  ON public.email_order_links FOR DELETE TO authenticated
  USING (public.can_access_email(auth.uid(), email_id));

-- ai_drafts
DROP POLICY IF EXISTS "员工可查看草稿" ON public.ai_drafts;
CREATE POLICY "员工可查看草稿"
  ON public.ai_drafts FOR SELECT TO authenticated
  USING (public.can_access_email(auth.uid(), email_id));

DROP POLICY IF EXISTS "员工可创建草稿" ON public.ai_drafts;
CREATE POLICY "员工可创建草稿"
  ON public.ai_drafts FOR INSERT TO authenticated
  WITH CHECK (public.can_access_email(auth.uid(), email_id));

DROP POLICY IF EXISTS "员工可更新草稿" ON public.ai_drafts;
CREATE POLICY "员工可更新草稿"
  ON public.ai_drafts FOR UPDATE TO authenticated
  USING (public.can_access_email(auth.uid(), email_id))
  WITH CHECK (public.can_access_email(auth.uid(), email_id));

-- email_processing_events
DROP POLICY IF EXISTS "员工可查看处理时间线" ON public.email_processing_events;
CREATE POLICY "员工可查看处理时间线"
  ON public.email_processing_events FOR SELECT TO authenticated
  USING (public.can_access_email(auth.uid(), email_id));

DROP POLICY IF EXISTS "员工可写入处理时间线" ON public.email_processing_events;
CREATE POLICY "员工可写入处理时间线"
  ON public.email_processing_events FOR INSERT TO authenticated
  WITH CHECK (public.can_access_email(auth.uid(), email_id));

-- email_order_recommendations
DROP POLICY IF EXISTS "员工可查看订单推荐" ON public.email_order_recommendations;
CREATE POLICY "员工可查看订单推荐"
  ON public.email_order_recommendations FOR SELECT TO authenticated
  USING (public.can_access_email(auth.uid(), email_id));

DROP POLICY IF EXISTS "员工可管理订单推荐" ON public.email_order_recommendations;
CREATE POLICY "员工可管理订单推荐"
  ON public.email_order_recommendations FOR ALL TO authenticated
  USING (public.can_access_email(auth.uid(), email_id))
  WITH CHECK (public.can_access_email(auth.uid(), email_id));

-- order_compensation_tasks
DROP POLICY IF EXISTS "员工可查看补偿任务" ON public.order_compensation_tasks;
CREATE POLICY "员工可查看补偿任务"
  ON public.order_compensation_tasks FOR SELECT TO authenticated
  USING (public.can_access_email(auth.uid(), email_id));

DROP POLICY IF EXISTS "员工可管理补偿任务" ON public.order_compensation_tasks;
CREATE POLICY "员工可管理补偿任务"
  ON public.order_compensation_tasks FOR ALL TO authenticated
  USING (public.can_access_email(auth.uid(), email_id))
  WITH CHECK (public.can_access_email(auth.uid(), email_id));

-- email_send_logs
DROP POLICY IF EXISTS "员工可查看发送日志" ON public.email_send_logs;
CREATE POLICY "员工可查看发送日志"
  ON public.email_send_logs FOR SELECT TO authenticated
  USING (
    public.is_staff(auth.uid())
    AND (
      email_id IS NULL AND mailbox_id IS NOT NULL AND public.can_access_mailbox(auth.uid(), mailbox_id)
      OR email_id IS NOT NULL AND public.can_access_email(auth.uid(), email_id)
    )
  );

-- risk_intercept_logs
DROP POLICY IF EXISTS "员工可查看风控日志" ON public.risk_intercept_logs;
CREATE POLICY "员工可查看风控日志"
  ON public.risk_intercept_logs FOR SELECT TO authenticated
  USING (public.can_access_email(auth.uid(), email_id));

DROP POLICY IF EXISTS "员工可创建风控日志" ON public.risk_intercept_logs;
CREATE POLICY "员工可创建风控日志"
  ON public.risk_intercept_logs FOR INSERT TO authenticated
  WITH CHECK (public.can_access_email(auth.uid(), email_id));

DROP POLICY IF EXISTS "员工可更新风控日志" ON public.risk_intercept_logs;
CREATE POLICY "员工可更新风控日志"
  ON public.risk_intercept_logs FOR UPDATE TO authenticated
  USING (public.can_access_email(auth.uid(), email_id))
  WITH CHECK (public.can_access_email(auth.uid(), email_id));

-- email_attachments
DROP POLICY IF EXISTS "员工可查看附件记录" ON public.email_attachments;
CREATE POLICY "员工可查看附件记录"
  ON public.email_attachments FOR SELECT TO authenticated
  USING (public.can_access_email(auth.uid(), email_id));

DROP POLICY IF EXISTS "员工可管理附件记录" ON public.email_attachments;
CREATE POLICY "员工可管理附件记录"
  ON public.email_attachments FOR ALL TO authenticated
  USING (public.can_access_email(auth.uid(), email_id))
  WITH CHECK (public.can_access_email(auth.uid(), email_id));

-- ops_alerts：有 related_email_id 时按邮件授权；无则仅 admin
DROP POLICY IF EXISTS "员工可查看告警" ON public.ops_alerts;
CREATE POLICY "员工可查看告警"
  ON public.ops_alerts FOR SELECT TO authenticated
  USING (
    public.is_staff(auth.uid())
    AND (
      related_email_id IS NULL AND public.has_role(auth.uid(), 'admin')
      OR related_email_id IS NOT NULL AND public.can_access_email(auth.uid(), related_email_id)
    )
  );

DROP POLICY IF EXISTS "员工可管理告警" ON public.ops_alerts;
CREATE POLICY "员工可管理告警"
  ON public.ops_alerts FOR ALL TO authenticated
  USING (
    public.is_staff(auth.uid())
    AND (
      related_email_id IS NULL AND public.has_role(auth.uid(), 'admin')
      OR related_email_id IS NOT NULL AND public.can_access_email(auth.uid(), related_email_id)
    )
  )
  WITH CHECK (
    public.is_staff(auth.uid())
    AND (
      related_email_id IS NULL AND public.has_role(auth.uid(), 'admin')
      OR related_email_id IS NOT NULL AND public.can_access_email(auth.uid(), related_email_id)
    )
  );

-- storage email-attachments：路径首段为 email_id
DROP POLICY IF EXISTS "员工可查看邮件附件" ON storage.objects;
CREATE POLICY "员工可查看邮件附件"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'email-attachments'
    AND public.is_staff(auth.uid())
    AND (
      (storage.foldername(name))[1] IS NOT NULL
      AND public.can_access_email(auth.uid(), ((storage.foldername(name))[1])::uuid)
    )
  );

DROP POLICY IF EXISTS "员工可上传邮件附件" ON storage.objects;
CREATE POLICY "员工可上传邮件附件"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'email-attachments'
    AND public.is_staff(auth.uid())
    AND (
      (storage.foldername(name))[1] IS NOT NULL
      AND public.can_access_email(auth.uid(), ((storage.foldername(name))[1])::uuid)
    )
  );
