# mail-guide-ai v1.7.0 + v1.7.1 + v1.7.2 同批上线说明（请运维按序执行）

> 研发发版文档 · 同批从 **v1.6.0 → v1.7.2**（含 1.7.0 附件修复 + 1.7.1 取消定时草稿 + 1.7.2 历史往来含发件信息）  
> 模板见 `docs/ops-release-notice-template.md`

**发版类型**：v1.6.0 → **v1.7.2**（同批合并 1.7.0 + 1.7.1 + 1.7.2，只跑 **一次** 发版脚本 + **一次** 前端 Pipeline）  
**代码分支**：GitLab `main`  
**提交号**：`d2e8bc703b6b9d5ce5123cf9f2403c28c6ff84ce`（功能 tip：v1.7.2 前端 + 清单；同批另有 `810f5bb` / `3b0afec`）  
**建议顺序**：同步代码 → 后端脚本（Functions + migration + vault/cron）→ 环境变量（跳过）→ **前端 Pipeline（必做）** → 验收

---

## 本次上线内容

| 版本/范围 | 主要变化 |
|-----------|----------|
| **v1.7.0 后端** | 同步 Edge Functions：`sync-mailbox`、`run-email-attachment-repair-tasks`、`_shared/imap-bodystructure` |
| **入站附件** | 用户附件数与 Gmail 对齐（user/inline）；去掉 count≥3 占位门闸；大邮件仅按 RFC822.SIZE；补拉错误透传；auto 内联默认上限 3MB |
| **v1.7.1 后端** | 取消 pg_cron 定时自动生成草稿（`auto-draft-every-30min`）；vault/cron 脚本不再注册该任务 |
| **人工能力** | 人工 `generate-draft` / 工作台生成草稿**不受影响** |
| **v1.7.2 前端** | **历史邮件往来含发件信息**：工作台详情「历史往来」将同配对的**入站邮件**与 **`email_send_logs` 发件记录**按时间混排；可查看已发送内容（手工回复 / AI 草稿 / 自动模板 / ERP 通知等）；点击入站可跳转，点击发件可看发送详情 |
| **数据库** | v1.7.2 **无新 migration**（读现有 `email_send_logs`）；同批仍含 1.7.1 的 `unschedule` SQL（已执行会自动跳过） |

---

## 研发需单独提供（不进 Git）

| 材料 | 用途 |
|------|------|
| 生产 `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY` | 前端 Jenkins 构建（须为生产 Kong 地址，非 localhost/测试库） |
| 无新增 `.env.functions` 密钥 | 本批不改 functions 必填项；现网已有配置即可 |

**发版清单** `mail-guide-ai-main/deploy/backend-release.env` **已在 Git**，Jenkins rsync `deploy/` 后自动下发，运维**无需**向研发另要该文件。

同批清单要点（务必核对）：

```text
RELEASE_VERSION="v1.7.2"
MIGRATIONS=("20260714120000_unschedule_auto_draft_cron.sql")
RUN_APPLY_VAULT_AND_CRON="true"
APPLY_FUNCTIONS="true"
BACKUP_FUNCTIONS="true"
```

> 若清单里 `APPLY_FUNCTIONS=false`，会漏同步 1.7.0 附件相关 Functions，**同批禁止**使用旧版仅含 1.7.1、且关闭 Functions 的清单。  
> 若现网已装过 1.7.0/1.7.1，SQL 与 Functions 会由脚本幂等跳过/覆盖，**仍须执行前端 Pipeline**（本批 v1.7.2 能力依赖新前端）。

---

## 服务器路径

| 项 | 路径 |
|----|------|
| 发版暂存 | `/data/temp/mail-guide-ai-main` |
| 自建 Supabase | `/data/service/supabase-selfhost` |
| Functions 环境变量 | `/data/service/supabase-selfhost/.env.functions` |

---

## 执行步骤

### 第 1 步：Jenkins 同步代码

**目的**：把发版脚本、SQL、Functions 源码、清单同步到服务器。

**操作**：rsync 到 `/data/temp/mail-guide-ai-main/`，须包含：

- `mail-guide-ai-main/scripts/`
- `mail-guide-ai-main/supabase/`（含 functions 与本次 migration）
- `mail-guide-ai-main/deploy/`（含 `backend-release.env`）

**注意**：不要同步含真实密码的 `.env.functions`。

---

### 第 2 步：执行后端发版脚本

**目的**：一次完成：同步 1.7.0 附件相关 Functions、执行取消自动草稿的 migration、按新脚本同步 vault/cron（卸载 auto-draft 且不再注册）。

**操作**：

```bash
chmod +x /data/temp/mail-guide-ai-main/scripts/linux/selfhosted/*.sh \
         /data/temp/mail-guide-ai-main/scripts/linux/*.sh

bash /data/temp/mail-guide-ai-main/scripts/linux/selfhosted/apply-backend-release.sh \
  /data/temp/mail-guide-ai-main \
  /data/service/supabase-selfhost \
  /data/temp/mail-guide-ai-main/deploy/backend-release.env
```

**本次 SQL 清单**：

- `20260714120000_unschedule_auto_draft_cron.sql`（`cron.unschedule('auto-draft-every-30min')`）

**说明**：

- 已执行过的 migration 会自动跳过，无需运维事先查库
- `APPLY_FUNCTIONS=true`：备份并替换业务 Functions（**保留 `hello`、`main`**）
- `RUN_APPLY_VAULT_AND_CRON=true`：**必须**；否则可能漏卸载 / 被旧逻辑重新注册 auto-draft
- v1.7.2 **无额外 SQL**；后端脚本仍须跑（同批从 1.6.0 起的 Functions/cron 对齐）

**禁止**：全量重跑整个 `supabase/migrations/`；禁止用未更新的旧版 vault/cron 脚本覆盖现网。

---

### 第 3 步：环境变量

**目的**：确认无需新增 `.env.functions` 项。

**操作**：本次**跳过**手工写入。1.7.0 代码内增量 auto 内联默认上限已改为 3MB，无需强制改 env。

---

### 第 4 步：前端（**本批必做**）

**目的**：上线 v1.7.2「历史往来含发件信息」页面能力。

**操作**：

1. 跑 **前端 Jenkins Pipeline**（或等价 build/deploy），拉取本 tip 及以后代码。
2. 构建时使用生产 `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`（**须为生产 Kong**，非 localhost / 测试库 / 云端临时 URL）。
3. 重新 **build 并部署**前端镜像/产物；部署后强刷或清 CDN 缓存（若有）。

**说明**：本能力仅读现有表 `email_send_logs`，无新 migration；**不做前端发版则历史往来仍无旧 UI**。

---

### 第 5 步：验收

**目的**：确认 Functions、migration、cron、前端历史往来均已生效。

**操作**：

```bash
cd /data/service/supabase-selfhost
docker compose ps functions db
docker compose exec -T db psql -U postgres -d postgres -c \
  "SELECT filename, release_version, applied_at FROM ops.backend_release_migrations ORDER BY applied_at DESC LIMIT 10;"
docker compose exec -T db psql -U postgres -d postgres -c \
  "SELECT jobname, schedule FROM cron.job ORDER BY jobname;"
docker compose exec -T db psql -U postgres -d postgres -c \
  "SELECT count(*) AS auto_draft_jobs FROM cron.job WHERE jobname = 'auto-draft-every-30min';"
docker compose logs functions --tail 80

export REPO_ROOT=/data/service/cs-main
export SELFHOST_ROOT=/data/service/supabase-selfhost
bash "$REPO_ROOT/mail-guide-ai-main/scripts/linux/post-deploy-verify.sh"
```

**通过标准**：

| 检查 | 期望 |
|------|------|
| `functions` 容器 | Up；发版脚本 Functions 备份/替换无报错 |
| `ops.backend_release_migrations` | 出现 `20260714120000_unschedule_auto_draft_cron.sql`；`release_version` 可为 `v1.7.1` 或 `v1.7.2`（幂等跳过时保留首次记录亦可） |
| `auto-draft-every-30min` | `count(*) = 0` |
| 其它业务 cron | 仍在（如 mailbox sync、compensation、body/attachment repair 等） |
| 附件抽查 | 含真实附件邮件：`attachments` 数量与 Gmail 接近；小附件可补拉预览/下载 |
| 草稿抽查 | 工作台 / 人工 generate-draft 仍可手动生成草稿；**不再**定时自动出草稿 |
| **前端·历史往来** | 打开有往来的工作台详情 →「历史往来」同时出现入站与发件条目，按时间混排 |
| **前端·发件详情** | 可打开发件记录，看到已发送内容（手工 / AI 草稿 / 自动模板 / ERP 通知等）；入站条目可跳转 |

**发版后通知业务**：

| 项 | 说明 |
|----|------|
| 入站附件 | 数量更准；原先卡住的小附件可尝试刷新/补拉 |
| 自动草稿 | 线上不再定时生成草稿；需草稿时由客服在工作台或人工触发 |
| 历史往来 | 工作台可查看同配对已发送内容与入站混排；便于核对回复/通知是否发出 |

---

## 步骤一览

| 步 | 目的 | 动作 |
|----|------|------|
| 1 | 代码到位 | rsync `scripts/`、`supabase/`、`deploy/` |
| 2 | 后端上线 | `apply-backend-release.sh`（**Functions + migration + vault/cron**） |
| 3 | 环境变量 | 本次跳过 |
| 4 | 页面更新 | **必做**：前端 Pipeline + 生产 `VITE_SUPABASE_*` build/部署 |
| 5 | 确认 OK | Functions 健康 + `auto-draft` 不存在 + 附件抽查 + **历史往来含发件** + `post-deploy-verify.sh` |

---

## 禁止事项

- 禁止全量重跑 `supabase/migrations/`
- 禁止用本机 `.env` / `.env.functions` 覆盖现网密钥
- 禁止同批时将 `APPLY_FUNCTIONS` 设为 `false`（会漏 1.7.0 附件 Functions）
- 禁止将 `RUN_APPLY_VAULT_AND_CRON` 设为 `false`（会漏卸载 / 可能被旧脚本加回 auto-draft）
- 禁止删除运行时 `hello`、`main` Functions 目录
- 禁止跳过前端 Pipeline（否则 v1.7.2 历史往来能力不上线）
- 禁止用 localhost / 测试库的 `VITE_SUPABASE_*` 打生产包

---

## 异常联系

脚本报错即停发版，保留终端输出与 `db`/`functions` 日志，联系研发：______________
