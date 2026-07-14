# Changelog

All notable changes to this project are documented in this file.

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
