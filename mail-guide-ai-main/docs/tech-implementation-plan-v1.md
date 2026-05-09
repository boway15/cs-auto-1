# 技术实现方案 v1（结合当前项目进展）

> **冲突说明**：与历史 v1 不一致处以 `docs/customer-service-automation-spec.md` §0 为准。

## 1. 当前基线

- 前端：React + Vite（`src/pages/Workbench.tsx`）
- 后端：**Supabase Edge Functions（Deno）** — **自建库与云端库一致**，均为同一套 Edge Runtime；区别仅在部署方式（云端常用 `supabase functions deploy`，自建为 `functions` 容器 + 同步 `supabase/functions/` 源码），**不是**换成 Node 或其它后端框架。
- AI：Dify（本机或内网，经网关暴露）
- 定时：`pg_cron + pg_net`
- **生产发布**：**自建 Supabase Docker**（`supabase-selfhost`）；cron URL 须指向自建 Kong，**非** `*.supabase.co`

本方案在现有基线上增量实施，不切换到 Node 自托管（参见 `docs/risk-and-plan.md` 仅为历史规划稿）。

## 2. 数据层变更

### 2.1 emails

迁移文件：`supabase/migrations/20260508090000_emails_business_intent_and_close.sql`

- 新增：`business_intent`, `intent_legacy`, `closed_at`, `closed_by`, `sla_bucket`（**产品主流程不强调 `closed`**，库内字段可保留兼容）
- CHECK：
  - `business_intent` 7 类
  - `status` 含 `closed`（历史/兼容）
  - `association_status` 含 `not_provided/not_found`
  - `sla_bucket` 四档

### 2.2 补偿任务

- 历史：`20260508090100_compensation_default_six.sql`（曾默认 6）
- **当前**：`20260510120000_compensation_ten_retries_thirty_min.sql` — `max_retries` 默认 **10**；pending 任务抬升上限

**调度间隔**：Edge `run-compensation-tasks` / `process-email` 创建任务时 `next_run_at` 为 **+30 分钟**；建议 pg_cron 同周期调用。

### 2.3 告警幂等

迁移文件：`20260508090200_ops_alerts_idempotency.sql`

- 新增：`idempotency_key`, `email_sent_at`, `email_send_error`
- 唯一索引：`uniq_ops_alerts_idem`

### 2.4 历史回填

迁移文件：`20260508090300_emails_full_backfill.sql`

### 2.5 Date 头口径

- `supabase/functions/sync-mailbox/index.ts`
- `20260507120000_emails_received_at_is_message_date.sql` 等

### 2.6 语言 / 情绪

- `20260509120000_emails_ai_language_sentiment.sql`

## 3. Functions 变更

### 3.1 共享模块

- `supabase/functions/_shared/ops-notify.ts`：`createAlertAndNotify()`；**固定发件邮箱**在 `mailboxes` 配置；密钥 **secrets**
- `supabase/functions/_shared/draft.ts`：本地草稿（消费 `ai_language` / `ai_sentiment`）+ Dify 草稿

### 3.2 process-email

- `business_intent`、关联、`sendTemplateReply`（24h + secrets）
- 补偿任务 `next_run_at`：**+30 分钟**
- **不**在 process-email 内对 `not_provided` 发内部预警

### 3.3 risk-intercept / run-compensation-tasks

- `risk-intercept`：**不调用 Shopify**；仅本地 `orders` hold；ERP 后续按 `erp-api-requirements.md`
- `run-compensation-tasks`：失败重试 **10** 次（`max_retries`），`next_run_at` **+30 分钟**
- 失败 → `createAlertAndNotify`

### 3.4 close-email（遗留）

`supabase/functions/close-email/index.ts` 仍可部署；**产品主流程不强调 `closed`**，工作台以「已回复」为主，**可不调用** close-email。

### 3.5 schedule-draft-generation

- 每 30 分钟 cron
- **1～6h**：Dify；**6～24h**：本地；收信满 **1h** 才参与；24h 内

### 3.6 schedule-compensating-alerts

- compensating + 收信 **≥2h 且 ≤72h** 内部预警；去重

### 3.7 generate-draft（人工）

- 固定 `mode='local'`

## 4. 定时任务与配置

### 4.1 Cron

- `20260508091000_cron_schedule_draft_generation.sql`：`auto-draft-every-30min` → `schedule-draft-generation`
- `20260509120100_cron_schedule_compensating_alerts.sql`：`compensating-alerts-every-30min`
- **自建**：须将 SQL 内 URL 替换为自建 `Kong` 的 functions 地址，并配置 `vault.decrypted_secrets.service_role_key`

### 4.2 Functions 配置

`supabase/config.toml`：`schedule-draft-generation`、`schedule-compensating-alerts` 等 `verify_jwt = false`（cron 使用 service role）

## 5. 前端实现

### 5.1 工作台

`src/pages/Workbench.tsx`

- 意图筛选 7 类 `business_intent`；关联筛选含 `not_provided/not_found/linked` 等
- SLA 标签（仅 pending/processing）
- 「生成草稿」强制 `mode: local`
- 风控文案：**不承诺 Shopify**；指向 ERP 文档
- **不强制**「标记已处理 / close-email」为主路径（产品仅保留已回复）

### 5.2 告警页

`src/pages/Alerts.tsx`：`resolved` 展示 **已处理**；按钮「标记已处理」

### 5.3 展示组件

- `src/components/StatusBadge.tsx`：`closed` 可与 `replied` 同文案「已回复」（兼容历史）
- `src/lib/customerService.ts`：意图/关联/SLA

## 6. Dify 工作流

`dify-workflows/email-analysis.yml`：`business_intent` 等与后端对齐

## 7. 文档与技能

- `docs/customer-service-automation-spec.md`（主口径）
- `docs/self-hosted-supabase.md`（自建发布）
- `.cursor/skills/mail-guide-ai-dev/SKILL.md`

## 8. 部署顺序（自建）

1. 启动 `supabase-selfhost`，配置 `.env` / `.env.functions`
2. `db push` 或执行 migrations
3. 修正 vault + cron URL（不打 Cloud）
4. 同步 Edge Functions 源码并重建 `functions` 容器
5. 部署前端，配置 `VITE_SUPABASE_URL`
6. 导入 Dify workflow，配置 secrets

## 9. 回滚策略

- 停用相关 cron
- `process-email` / 调度函数回退版本
- 数据库新增列保持兼容
