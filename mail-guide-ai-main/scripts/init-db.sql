-- ============================================================
-- mail-guide-ai 本地数据库初始化脚本
-- 适用于 PostgreSQL 15
-- 注意：此脚本创建业务表，不含 Supabase Auth 相关表
-- ============================================================

-- 1. 邮箱配置
CREATE TABLE IF NOT EXISTS mailboxes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_address TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  incoming_host TEXT NOT NULL,
  incoming_port INTEGER NOT NULL DEFAULT 993,
  smtp_host     TEXT NOT NULL,
  smtp_port     INTEGER NOT NULL DEFAULT 465,
  use_ssl       BOOLEAN DEFAULT true,
  username      TEXT,
  password_enc  TEXT,
  is_active     BOOLEAN DEFAULT true,
  last_sync_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- 2. ERP 配置
CREATE TABLE IF NOT EXISTS erp_configs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  base_url       TEXT NOT NULL,
  auth_type      TEXT DEFAULT 'bearer',
  auth_token     TEXT,
  order_endpoint TEXT DEFAULT '/orders',
  field_mapping  JSONB DEFAULT '{}',
  sync_interval  INTEGER DEFAULT 15,
  last_sync_at   TIMESTAMPTZ,
  is_active      BOOLEAN DEFAULT true,
  config_audit   JSONB DEFAULT '[]',
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

-- 3. 订单
CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no        TEXT NOT NULL UNIQUE,
  customer_email  TEXT,
  customer_name   TEXT,
  product_summary TEXT,
  shipping_status TEXT,
  tracking_no     TEXT,
  order_status    TEXT,
  amount          NUMERIC(12,2),
  currency        TEXT DEFAULT 'USD',
  ordered_at      TIMESTAMPTZ,
  raw_data        JSONB DEFAULT '{}',
  source          TEXT DEFAULT 'erp',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- 4. 邮件
-- received_at 业务口径：取邮件 RFC 5322 Date 头；无效或缺失时回退为入库时刻
-- status 流转：pending/processing 为流转中；replied 为系统发信后自动结案；closed 为人工结案（已处理）
-- business_intent 为 7 类业务意图（唯一枚举 + 单选 + 可人工修改），与 intent_legacy 过渡期并存
-- sla_bucket 仅对 pending/processing 有意义，按 received_at 固定时钟计算
CREATE TABLE IF NOT EXISTS emails (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id      UUID REFERENCES mailboxes(id) ON DELETE SET NULL,
  message_id      TEXT,
  from_email      TEXT,
  from_name       TEXT,
  to_email        TEXT,
  cc              TEXT,
  subject         TEXT,
  body_text       TEXT,
  body_html       TEXT,
  received_at     TIMESTAMPTZ,
  status          TEXT DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','replied','closed')),
  is_read         BOOLEAN DEFAULT false,
  priority        TEXT DEFAULT 'normal'
                  CHECK (priority IN ('low','normal','high','urgent')),
  category        TEXT,
  intent          TEXT,
  business_intent TEXT
                  CHECK (business_intent IS NULL OR business_intent IN (
                    'order_cancel','address_change','delay_shipping','sku_change','damaged','defect','description_mismatch','logistics','other',
                    'amazon_marketplace','product_inquiry','conversation_idle','solution_accepted'
                  )),
  intent_legacy   TEXT,
  ai_summary      TEXT,
  ai_entities     JSONB DEFAULT '{}',
  is_info_complete BOOLEAN DEFAULT false,
  missing_elements JSONB DEFAULT '[]',
  association_status TEXT DEFAULT 'unlinked'
                  CHECK (association_status IN ('unlinked','not_provided','not_found','compensating','recommended','linked','manual_unlink')),
  processing_status TEXT DEFAULT 'pending',
  risk_level      TEXT DEFAULT 'normal',
  sla_bucket      TEXT
                  CHECK (sla_bucket IS NULL OR sla_bucket IN ('within_24h','within_48h','within_72h','over_72h')),
  thread_id       TEXT,
  ai_analyzed_at  TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ,
  closed_by       UUID,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- 5. 邮件-订单关联
CREATE TABLE IF NOT EXISTS email_order_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id      UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  link_source   TEXT DEFAULT 'manual'
                CHECK (link_source IN ('manual','recommended','auto')),
  confidence    NUMERIC(5,2),
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(email_id, order_id)
);

-- 6. 邮件订单推荐
CREATE TABLE IF NOT EXISTS email_order_recommendations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id   UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  order_id   UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  score      NUMERIC(5,2) DEFAULT 0,
  reason     TEXT,
  status     TEXT DEFAULT 'pending'
             CHECK (status IN ('pending','accepted','rejected','expired')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 7. AI 草稿
CREATE TABLE IF NOT EXISTS ai_drafts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id      UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  version       INTEGER DEFAULT 1,
  draft_content TEXT NOT NULL,
  model         TEXT DEFAULT 'deepseek',
  guidance      TEXT,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 8. 邮件处理事件（时间线）
CREATE TABLE IF NOT EXISTS email_processing_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id    UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  actor_type  TEXT DEFAULT 'system'
              CHECK (actor_type IN ('system','user','ai')),
  actor_id    UUID,
  title       TEXT,
  description TEXT,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- 9. 回复模板
CREATE TABLE IF NOT EXISTS reply_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  trigger_type    TEXT NOT NULL,
  subject_template TEXT,
  body_template   TEXT NOT NULL,
  variables       TEXT[] DEFAULT '{}',
  auto_send       BOOLEAN DEFAULT false,
  is_active       BOOLEAN DEFAULT true,
  updated_by      UUID,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- 10. 发送日志
CREATE TABLE IF NOT EXISTS send_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id      UUID REFERENCES emails(id) ON DELETE SET NULL,
  template_id   UUID REFERENCES reply_templates(id) ON DELETE SET NULL,
  send_type     TEXT NOT NULL
                CHECK (send_type IN ('manual','ai_draft','auto_template','forward')),
  status        TEXT DEFAULT 'pending'
                CHECK (status IN ('pending','sent','failed','bounced')),
  from_email    TEXT,
  to_email      TEXT NOT NULL,
  subject       TEXT,
  content       TEXT,
  send_no       TEXT,
  smtp_response TEXT,
  error_message TEXT,
  message_id    TEXT,
  order_id      UUID REFERENCES orders(id) ON DELETE SET NULL,
  order_no      TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 11. 风控日志
CREATE TABLE IF NOT EXISTS risk_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID REFERENCES orders(id) ON DELETE SET NULL,
  email_id        UUID REFERENCES emails(id) ON DELETE SET NULL,
  action          TEXT NOT NULL,
  intercept_reason TEXT,
  reason_category TEXT,
  trigger_source  TEXT DEFAULT 'manual'
                  CHECK (trigger_source IN ('manual','auto','webhook')),
  status          TEXT DEFAULT 'pending'
                  CHECK (status IN ('pending','success','failed','retrying')),
  shopify_response JSONB,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- 12. 用户角色（配合 Supabase Auth）
CREATE TABLE IF NOT EXISTS user_roles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL,
  role       TEXT NOT NULL
             CHECK (role IN ('admin','leader','agent','guest')),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, role)
);

-- 13. 订单补偿任务（订单号匹配失败时挂起，每小时重试，最多 6 次）
CREATE TABLE IF NOT EXISTS order_compensation_tasks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id          UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  order_no          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','resolved','failed')),
  retry_count       INTEGER NOT NULL DEFAULT 0,
  max_retries       INTEGER NOT NULL DEFAULT 6,
  next_run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error        TEXT,
  resolved_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(email_id, order_no)
);

-- 14. 运营告警（拦截失败 / 补偿失败 / 自动回复失败 等）
-- idempotency_key 保证「同一事件不重复发邮件」
CREATE TABLE IF NOT EXISTS ops_alerts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source            TEXT NOT NULL,
  severity          TEXT NOT NULL DEFAULT 'warning',
  title             TEXT NOT NULL,
  message           TEXT,
  related_email_id  UUID REFERENCES emails(id) ON DELETE SET NULL,
  related_order_id  UUID REFERENCES orders(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'open',
  metadata          JSONB NOT NULL DEFAULT '{}',
  idempotency_key   TEXT,
  email_sent_at     TIMESTAMPTZ,
  email_send_error  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_ops_alerts_idem
  ON ops_alerts(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ops_alerts_status_created
  ON ops_alerts(status, created_at DESC);

-- 索引
CREATE INDEX IF NOT EXISTS idx_emails_received_at ON emails(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);
CREATE INDEX IF NOT EXISTS idx_emails_from_email ON emails(from_email);
CREATE INDEX IF NOT EXISTS idx_emails_business_intent ON emails(business_intent);
CREATE INDEX IF NOT EXISTS idx_emails_sla_bucket ON emails(sla_bucket) WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS idx_emails_closed_at ON emails(closed_at DESC) WHERE status = 'closed';
CREATE INDEX IF NOT EXISTS idx_emails_association_status ON emails(association_status);
CREATE INDEX IF NOT EXISTS idx_email_order_links_email ON email_order_links(email_id);
CREATE INDEX IF NOT EXISTS idx_email_order_links_order ON email_order_links(order_id);
CREATE INDEX IF NOT EXISTS idx_email_order_recommendations_email ON email_order_recommendations(email_id);
CREATE INDEX IF NOT EXISTS idx_ai_drafts_email ON ai_drafts(email_id);
CREATE INDEX IF NOT EXISTS idx_email_processing_events_email ON email_processing_events(email_id);
CREATE INDEX IF NOT EXISTS idx_send_logs_created ON send_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_logs_created ON risk_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_order_no ON orders(order_no);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_order_compensation_due ON order_compensation_tasks(status, next_run_at);

-- 15. 用户邮箱授权（Supabase 部署见 migrations/20260522140000_user_mailbox_grants_rls.sql）
CREATE TABLE IF NOT EXISTS user_mailbox_grants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  mailbox_id  UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  granted_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, mailbox_id)
);
CREATE INDEX IF NOT EXISTS idx_user_mailbox_grants_user ON user_mailbox_grants(user_id);
CREATE INDEX IF NOT EXISTS idx_user_mailbox_grants_mailbox ON user_mailbox_grants(mailbox_id);
