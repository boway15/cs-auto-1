# 技术实现方案 v1（结合当前项目进展）

## 1. 当前基线

- 前端：React + Vite（`src/pages/Workbench.tsx`）
- 后端：Supabase Edge Functions（Deno）
- AI：Dify（本机，通过 ngrok 暴露）
- 定时：`pg_cron + pg_net`

本方案在现有基线上增量实施，不切换到 Node 自托管。

## 2. 数据层变更

### 2.1 emails

迁移文件：`supabase/migrations/20260508090000_emails_business_intent_and_close.sql`

- 新增：`business_intent`, `intent_legacy`, `closed_at`, `closed_by`, `sla_bucket`
- CHECK：
  - `business_intent` 7 类
  - `status` 含 `closed`
  - `association_status` 含 `not_provided/not_found`
  - `sla_bucket` 四档

### 2.2 补偿任务

迁移文件：`20260508090100_compensation_default_six.sql`

- `order_compensation_tasks.max_retries` 默认改为 6

### 2.3 告警幂等

迁移文件：`20260508090200_ops_alerts_idempotency.sql`

- 新增：`idempotency_key`, `email_sent_at`, `email_send_error`
- 唯一索引：`uniq_ops_alerts_idem`

### 2.4 历史回填

迁移文件：`20260508090300_emails_full_backfill.sql`

- 复制 `intent -> intent_legacy`
- 映射 `business_intent`
- 修正 `recommended -> not_provided`（并清理 recommendation）
- 一次性计算 `sla_bucket`

### 2.5 Date 头口径

已通过：

- `supabase/functions/sync-mailbox/index.ts`
- `20260507120000_emails_received_at_is_message_date.sql`
- `20260507120100_emails_received_at_comment_invalid_date.sql`

固定为：Date 头无效即回退入库时间。

## 3. Functions 变更

### 3.1 共享模块

- `supabase/functions/_shared/ops-notify.ts`
  - `createAlertAndNotify()`
  - `ops_alerts` 写库 + 幂等去重 + SMTP 发邮件
- `supabase/functions/_shared/draft.ts`
  - 本地草稿 / Dify 草稿 / 草稿写入

### 3.2 process-email

`supabase/functions/process-email/index.ts`

- 输出并写入 `business_intent + intent_legacy`
- 无单号设置 `association_status = not_provided`，不再推荐订单
- `order_cancel/address_change` 且已关联订单时强制尝试拦截
- 自动回复失败与拦截调用失败接入统一告警
- 草稿由调度任务统一产出（避免双写）

### 3.3 risk-intercept / run-compensation-tasks

- 失败分支统一改为调用 `createAlertAndNotify()`
- 与 `ops_alerts.idempotency_key` 配合，确保同事件不重复发告警邮件

### 3.4 close-email（新增）

`supabase/functions/close-email/index.ts`

- 人工结案：`status='closed'`
- 写 `email_processing_events` 与 `audit_logs`

### 3.5 schedule-draft-generation（新增）

`supabase/functions/schedule-draft-generation/index.ts`

- 每 30 分钟由 cron 调用
- 0~4h：Dify；4~24h：本地；>=24h 跳过
- 仅处理 `pending/processing` 且无非空草稿

### 3.6 generate-draft（人工）

`supabase/functions/generate-draft/index.ts`

- 人工调用固定 `mode='local'`
- 自动草稿职责迁到 schedule function

## 4. 定时任务与配置

### 4.1 新增 Cron

`supabase/migrations/20260508091000_cron_schedule_draft_generation.sql`

- 任务名：`auto-draft-every-30min`
- 触发：`schedule-draft-generation`

### 4.2 Functions 配置

`supabase/config.toml` 已新增：

```toml
[functions.schedule-draft-generation]
verify_jwt = false
```

## 5. 前端实现

### 5.1 工作台

`src/pages/Workbench.tsx`

- 状态筛选增加 `closed`
- 意图筛选改为 7 类 `business_intent`
- 关联筛选支持 `not_provided/not_found/linked`
- SLA 标签（仅 pending/processing）
- “标记已处理”按钮调用 `close-email`
- “生成草稿”强制 `mode: local`
- `not_provided` 隐藏推荐区并显示业务说明

### 5.2 告警页

新增 `src/pages/Alerts.tsx`，并接入：

- `src/App.tsx` 路由 `/alerts`
- `src/components/AppLayout.tsx` 导航“运营告警”

### 5.3 展示组件

- `src/components/StatusBadge.tsx`：`closed` 文案改为“已处理”
- `src/lib/customerService.ts`：意图/关联/SLA 映射与工具函数

## 6. Dify 工作流

文件：`dify-workflows/email-analysis.yml`

- prompt 中新增 `business_intent` 定义（7 类单选）
- code 节点新增 `business_intent` 默认值和校验
- end 节点输出新增 `business_intent`

文档：`dify-workflows/README.md` 已同步更新部署/验证说明。

## 7. 文档与技能

- 新增：`docs/product-prd-v1.md`
- 新增：`docs/tech-implementation-plan-v1.md`（本文件）
- 需同步：`docs/startup-commands.md`、`.cursor/skills/mail-guide-ai-dev/SKILL.md`

## 8. 部署顺序

1. 执行数据库迁移（含 full backfill）
2. 部署共享模块依赖的 functions（process/risk/comp/close/schedule/generate）
3. 部署前端
4. 导入并发布 Dify workflow
5. 校验 cron 与告警邮件

## 9. 回滚策略

- 停用 `auto-draft-every-30min` cron
- 前端隐藏 `/alerts` 与新入口（必要时）
- `process-email` 回退到旧版本
- 数据库新增列保持兼容，不做 destructive 回滚

