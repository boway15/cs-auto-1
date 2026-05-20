# Changelog

All notable changes to this project are documented in this file.

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
