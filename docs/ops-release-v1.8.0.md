# mail-guide-ai v1.8.0 上线说明（请运维按序执行）

> 研发发版文档 · 对应 `RELEASE_VERSION=v1.8.0` · 模板见 `docs/ops-release-notice-template.md`

**发版类型**：v1.7.4 → **v1.8.0**  
**代码分支**：GitLab `main`  
**提交号**：`9803767afe619672a88be3de75ac3e62c8e9a460`  
**建议顺序**：同步代码 → 后端脚本 → 环境变量（本版跳过）→ 前端 → 验收

---

## 本次上线内容

| 版本/范围 | 主要变化 |
|-----------|----------|
| **v1.8.0 后端 + 库表** | 入库 `emails.reply_to_email`；自动回复优先 Reply-To |
| **v1.8.0 后端** | iPhone / `multipart/related` 内联图（cid）识别与补拉；修复工作台破图与误报「无附件」 |
| **v1.8.0 前端** | 工作台 Reply-To 确认、cid 破图自动触发补拉、正文/附件展示相关 |

---

## 研发需单独提供（不进 Git）

| 材料 | 用途 |
|------|------|
| 生产 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | 前端镜像构建（须指向生产 Kong，非 localhost） |
| 无新增 Functions 密钥 | 本版不强制改 `.env.functions` |

**发版清单** `mail-guide-ai-main/deploy/backend-release.env` **已在 Git**，Jenkins rsync `deploy/` 后自动下发，运维无需另要文件。

清单要点：

```text
RELEASE_VERSION="v1.8.0"
MIGRATIONS=(
  "20260716160000_emails_reply_to_email.sql"
)
RUN_APPLY_VAULT_AND_CRON="false"
APPLY_FUNCTIONS="true"
BACKUP_FUNCTIONS="true"
```

> **禁止**将 `APPLY_FUNCTIONS` 设为 `false`。本版**必须**重建前端。

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

**目的**：把发版脚本、SQL、清单、Functions 源码同步到服务器。

**操作**：rsync 到 `/data/temp/mail-guide-ai-main/`，须包含：

- `mail-guide-ai-main/scripts/`
- `mail-guide-ai-main/supabase/`
- `mail-guide-ai-main/deploy/`（含 `backend-release.env`）
- 若现网使用附件 Worker：另含 `docker-compose.worker.yml` 与 `scripts/workers/`（与 v1.7.4 一致，本版不改 Worker 配置）

**注意**：不要同步含真实密码的 `.env.functions`。

---

### 第 2 步：执行后端发版脚本

**目的**：执行数据库迁移、更新 Edge Functions、重启 functions。

**操作**：

```bash
chmod +x /data/temp/mail-guide-ai-main/scripts/linux/selfhosted/*.sh \
         /data/temp/mail-guide-ai-main/scripts/linux/*.sh

bash /data/temp/mail-guide-ai-main/scripts/linux/selfhosted/apply-backend-release.sh \
  /data/temp/mail-guide-ai-main \
  /data/service/supabase-selfhost \
  /data/temp/mail-guide-ai-main/deploy/backend-release.env
```

**说明**：

- 按 Git 中 `backend-release.env` 执行；**已执行过的 SQL 自动跳过**，无需运维事先查库
- `RUN_APPLY_VAULT_AND_CRON=false`：本版不改 vault/cron
- 同步业务 Edge Functions（**保留 `hello`、`main`**）

**禁止**：全量重跑整个 `supabase/migrations/` 目录。

**本次 SQL 清单（以 Git 中 `MIGRATIONS` 为准）**：

- `20260716160000_emails_reply_to_email.sql`

---

### 第 3 步：配置环境变量

**目的**：本版无新增必改 Functions 环境变量。

**操作**：**跳过**。勿因本版发版随意 recreate functions（第 2 步脚本已按需重启）。

若现网附件补拉仍慢/易超时，可另开工单核对（非本版强制）：

```text
EDGE_CPU_TIME_SOFT_LIMIT_MS=60000
EDGE_CPU_TIME_HARD_LIMIT_MS=120000
EDGE_WORKER_TIMEOUT_MS=150000
EDGE_MEMORY_LIMIT_MB=256
MAIL_ATTACHMENT_REPAIR_BATCH_LIMIT=1
```

改完须：

```bash
cd /data/service/supabase-selfhost
docker compose up -d --force-recreate --no-deps functions
```

---

### 第 4 步：部署前端

**目的**：更新工作台 Reply-To 确认、cid 破图自动补拉与正文展示。

**操作**：使用研发提供的生产 `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY` **重新 build 并部署**前端镜像（须为生产 Kong，非 localhost/测试库）。

---

### 第 5 步：验收

**目的**：确认发版成功。

**操作**：

```bash
cd /data/service/supabase-selfhost

docker compose ps functions db

docker compose exec -T db psql -U postgres -d postgres -c \
  "SELECT filename, release_version, applied_at FROM ops.backend_release_migrations ORDER BY applied_at DESC LIMIT 10;"

docker compose exec -T db psql -U postgres -d postgres -c \
  "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='emails' AND column_name='reply_to_email';"

# 确认 cid 补拉相关代码已同步
grep -n "detectAttachmentsFromMeta\|emailNeedsMediaBinarySync\|email-attachment-presence" \
  volumes/functions/sync-mailbox/index.ts \
  volumes/functions/_shared/imap-bodystructure.ts \
  volumes/functions/_shared/email-attachment-presence.ts | head -40

docker compose logs functions --tail 50

export REPO_ROOT=/data/service/cs-main
export SELFHOST_ROOT=/data/service/supabase-selfhost
# 若现网已挂仓库脚本，可执行：
# bash "$REPO_ROOT/mail-guide-ai-main/scripts/linux/post-deploy-verify.sh"
```

**通过标准**：

| 检查项 | 标准 |
|--------|------|
| 容器 | `functions`、`db` 为 Up |
| migration | `ops.backend_release_migrations` 可见 `20260716160000_emails_reply_to_email.sql` / `v1.8.0` |
| 列 | `emails.reply_to_email` 存在 |
| 代码 | volumes 中存在 `detectAttachmentsFromMeta` / `email-attachment-presence` |
| 日志 | 无持续报错 |
| 前端 | 能登录、能打开工作台 |

**业务冒烟（发版后通知业务）**：

| 场景 | 通过标准 |
|------|----------|
| Reply-To 邮件 | 回信/自动回复收件人优先 Reply-To；工作台有确认提示（若适用） |
| iPhone 破图样例 | 打开详情后图片可显示；或跑「补附件」后正文出图 |
| 库内字段 | 问题邮件 `has_attachment=true`，`attachments` 含 `filename` + `storage_path` |
| 要素缺失 | 有图后不再长期挂「无附件」（可刷新详情确认） |

对历史破图邮件可触发补附件阶段（邮箱同步「补附件」），或打开该邮件详情等待自动补拉。

**发版后请通知业务**：

| 角色 | 动作 |
|------|------|
| 客服/业务 | 抽测 Reply-To 回信；抽测此前 iPhone 破图工单是否已出图 |
| 研发 | 跟进仍破图个案：查 `email_attachment_repair_tasks` 与 functions 日志 |

---

## 步骤一览

| 步 | 目的 | 动作 |
|----|------|------|
| 1 | 代码到位 | Jenkins rsync（含 `deploy/backend-release.env`） |
| 2 | 后端上线 | `apply-backend-release.sh`（migration + Functions） |
| 3 | 环境变量 | 跳过（无强制改 `.env.functions`） |
| 4 | 页面更新 | 前端重建并部署 |
| 5 | 确认 OK | 查 migration / 列 / volumes 代码 / 业务冒烟 |

---

## 禁止事项

- 勿将 `.env.functions`、生产密钥提交 Git 或打进 Jenkins 包
- 勿全量重跑 migrations 目录
- 勿删除 `volumes/functions/` 下的 `hello`、`main`
- 勿将附件 Worker 的 `SUPABASE_URL` 设为 `http://127.0.0.1:8000`（容器内应使用 `http://supabase-kong:8000`，见 `docker-compose.worker.yml`）
- 勿依赖 `/tmp/*-override.yml` 补网络或 URL

---

## 异常联系

第 2 步脚本报错或 functions 持续异常：停止操作，保存脚本输出与 `docker compose logs functions`，联系研发。

**研发对接人**：________  
**运维负责人**：________  
**计划发版时间**：________
