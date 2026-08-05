# Changelog

All notable changes to this project are documented in this file.

## [1.10.0] - 2026-08-05

### Features

- **出站附件归档**：发送成功后将附件归档到 Storage `sent/{mailbox_id}/{send_log_id}/...`，并回写 `email_send_logs.metadata`；清理临时对象。
- **发送日志预览**：SendLogs 详情支持对已归档附件的签名预览/下载（按邮箱权限隔离）。

### Database

- `20260804120000_outbound_attachments_sent_archive_rls.sql`：员工可读 `outbound-attachments` 桶下 `sent/{mailbox_id}/...` 归档路径。

### Functions / Frontend

- `send-reply`、`_shared/outbound-attachment`
- `outbound-attachments`、`SendLogs`

### Release note

- 现网自 **v1.8.0** 起同批上线时，本版本号 **v1.10.0** 为 GitHub / `package.json` / Git 标签终点；中间已入库的 **v1.9.0**（Gmail 正文选段等）一并包含，不再单独打运维批次。

## [1.9.0] - 2026-07-31

### Fixes

- **Gmail 回复正文丢失**：MIME 选段改为引用感知评分，优先含客户新回复的 `text/plain`/`text/html`，不再因 Shopify 等引用原文更长而覆盖真实回复。
- **multipart/mixed**：优先 `multipart/alternative` 主段；`message/rfc822` 嵌入原文不参与正文候选；修复 rfc822 解析递归。
- **plain/html 不一致**：plain 含引用前新回复而 html 仅为 Shopify 模板时回退 plain，避免展示错正文。
- **手机签名误判**：「Sent from my iPhone」等不再视为完整正文；正文补拉可覆盖仅签名入库数据。
- **工作台发件人**：列表以 `from_email` 为稳定身份；详情加载不再覆盖列表发件人字段；邮箱筛选 Select 异步选项修复。
- **往来记录**：切换邮件时重置发信详情；出站日志展示发件人邮箱。

### Functions / Frontend

- `_shared/mime-parse`、`sync-mailbox`、`imap-text-body-repair`
- `email-body`、`Workbench`、`EmailPairHistoryList`

### Database

- 无新增 migration（`MIGRATIONS=()`）

## [1.8.0] - 2026-07-23

### Features

- **Reply-To**：入库 `emails.reply_to_email`；自动回复 / 工作台回信优先 Reply-To，并支持确认提示。
- **内联图补拉**：iPhone / `multipart/related` 的 `cid` 内联图视为需拉取媒体，修复工作台破图与误报「无附件」。

### Fixes

- BODYSTRUCTURE 启发式识别 `("NAME" "…")` / `RELATED+IMAGE`；正文含 `cid` 且本地无图时进入附件补拉扫描。
- 正文补拉完成后若仍缺内联图二进制，自动入队附件补拉；补拉成功后清理 `missing_elements` 中的 `attachment`/`image`。
- 工作台打开含 `cid` 破图邮件时自动触发补拉。

### Functions / Frontend

- `sync-mailbox`、`process-email`、`run-email-fetch-tasks`、`run-email-body-repair-tasks`
- `_shared/imap-bodystructure`、`_shared/email-attachment-presence`、`_shared/email-body-repair-queue`、`_shared/mime-parse`、`_shared/mail-reply-subject`
- 工作台：`Workbench`、`workbench-attachments`、`reply-to-confirm`、`email-body` 等

### Database

- `20260716160000_emails_reply_to_email.sql`

## [1.7.4] - 2026-07-15

### Fixes

- **附件补拉出 Edge 套娃**：`run-email-attachment-repair-tasks` 进程内调用共享 IMAP 补拉，不再 HTTP 调 `sync-mailbox`。
- **分 part 续传**：每轮默认 1～2 个 part，剩余任务 `next_run_at` 约 45s 后续跑；Edge CPU 取消类失败拉长退避（30min 起）。
- **Docker 附件 Worker**：`email-attachment-repair-worker`（`docker-compose.worker.yml`），长超时进程内 IMAP。
- **发版脚本**：CentOS 7 Bash 空 `MIGRATIONS=()` 不再 unbound。

### Functions / Scripts

- `_shared/imap-attachment-repair.ts`、`run-email-attachment-repair-tasks`、`sync-mailbox`（repair_full）
- `scripts/workers/email-attachment-repair-worker.ts`、`scripts/linux/selfhosted/apply-backend-release.sh`

### Database

- 无新增 migration（`MIGRATIONS=()`）

## [1.7.3] - 2026-07-15

### Fixes

- **附件补拉避免 Edge 整封回退超时**：`repairAttachmentsForRecord` 在已解析出 BODYSTRUCTURE part 时不再 `fetchFullBody`；优先按 encoding 直接解码单 part，降低 `WorkerRequestCancelled`。
- **禁止假 resolved**：附件 worker 仅在库内 `attachments` 含有效 `storage_path` 时标成功；回收超时 `running` 僵死锁。

### Functions

- `sync-mailbox`、`run-email-attachment-repair-tasks`、`_shared/mime-parse`、`_shared/imap-bodystructure`、`_shared/email-attachment-repair-queue`

### Database

- 无新增 migration（`MIGRATIONS=()`）

## [1.7.2] - 2026-07-14

### Features

- **工作台历史往来含发件信息**：同配对的入站邮件与 `email_send_logs` 发件记录按时间混排；可查看已发送内容（手工回复 / AI 草稿 / 自动模板 / ERP 通知等）；点击入站可跳转，点击发件可看发送详情。

### Frontend

- `Workbench`、`EmailPairHistoryList`、`workbench-send-logs`；可选正文展示清理（`email-body`）

### Database

- 无新增 migration（读现有 `email_send_logs`）

## [1.7.1] - 2026-07-14

### Changed

- **取消 pg_cron 定时自动生成草稿**：卸载 `auto-draft-every-30min`；人工 `generate-draft` / 工作台不受影响。
- **vault/cron 脚本同步**：`apply-vault-and-cron.sh` / `Apply-VaultAndCron.ps1` 不再注册该任务，发版时 `RUN_APPLY_VAULT_AND_CRON=true`，避免再次挂回。

### Database

- `20260714120000_unschedule_auto_draft_cron.sql`

## [1.7.0] - 2026-07-14

### Fixes

- **入站附件数量与 Gmail 对齐**：BODYSTRUCTURE 解析区分 user / inline，列表与标记仅统计用户附件，避免内嵌图虚报。
- **大邮件门闸收紧到 RFC822.SIZE**：去掉占位 `count≥3` 大门闸；小附件交互/后台补拉真正走 IMAP 分 part / 整封拉取。
- **附件补拉错误透传**：`repair_full` 与 `run-email-attachment-repair-tasks` 回传明确失败原因，避免空转重试。
- **自动同步内联体积上限**：增量 auto 默认 `1.5MB` → `3MB`，降低本可内联落库却误入队的比例。

### Functions

- `sync-mailbox`、`run-email-attachment-repair-tasks`、`_shared/imap-bodystructure`

### Database

- 无新增 migration（`MIGRATIONS=()`）

## [1.3.0] - 2026-05-27

### Features

- **ERP 拦截通知按站点发信**：新增 `erp_site_mailboxes`；`erp-notify-customer` 必填 `site_code`，发件邮箱由站点配置解析；模板变量扩展 `{{site_code}}`、`{{site_name}}`；422 写入发送日志且不占用幂等键。
- **超大附件补拉队列**：`email_attachment_repair_tasks` + `run-email-attachment-repair-tasks`；工作台/同步可触发；自建 cron 经 Kong 调度。
- **邮件正文与 MIME**：增强 `mime-parse`、`email-body` 与 `sync-mailbox` 附件处理；工作台附件展示与下载（`workbench-attachments`）。
- **管理端**：迅捷回邮模板页支持站点邮箱关联；发送日志展示 ERP 站点信息；模板/工作台体验优化。

### Database

- `20260527143000_email_attachment_repair_tasks.sql`
- `20260527143100_cron_email_attachment_repair_tasks.sql`
- `20260527143200_selfhost_cron_repair_tasks_kong.sql`（正文/附件补拉 cron 改 Kong）
- `20260527200000_erp_site_mailboxes.sql`

### Documentation

- 更新 `erp-notify-customer-api.md` 与 Apifox 导出（`site_code`、422 幂等说明）。

## [1.0.1] - 2026-05-20

### Features

- **客户自动化（Phase A）**：自动关联、自动拦截、自动回邮统一 **12 小时**发件时间窗；补偿步长 **20 分钟**、上限 **20 次**（收信 1 次 + 补偿 20 次）。
- **运营告警**：自动关联/拦截失败时各发 **首次 + 末次** `ops_alerts` 邮件（独立幂等键）；取消原 `schedule-compensating-alerts` 2h compensating 定时提醒。
- **部署**：`Apply-VaultAndCron` / `apply-vault-and-cron.sh` 改为 4 条业务 cron（含 `*/20` 补偿任务），并 `unschedule` `compensating-alerts-every-30min`。

### Documentation

- 更新 `production-go-live` §5.5、帮助中心、`customer-service-automation-spec` 与自建运维文档，与上述行为对齐。

### Database

- 迁移 `20260520120000_automation_12h_twenty_compensation_retries.sql`：`compensation_attempts_done <= 20`，`order_compensation_tasks.max_retries` 默认 20。

## [1.0.0] - 2026-05-19

### 封板

- 生产默认自建 Supabase + Dify；移除子项目内重复的 Dify compose/启动脚本与临时调试文件。
- 文档对齐自建栈路径（`migration-guide`、`startup-commands`、`.env.example` 说明）。
- 版本策略见仓库根目录 `docs/VERSIONING.md`。
