# mail-guide-ai v1.10.1 上线说明（请运维按序执行）

> 研发发版文档 · 对应 `RELEASE_VERSION=v1.10.1` · 在 v1.10.0 出站附件归档之上补齐工作台预览与详情弹窗滚动 · 模板见 `docs/ops-release-notice-template.md`  
> **本版增量主要为前端**；清单仍含 v1.10.0 的 SQL / Functions（已执行则自动跳过），便于现网自 v1.8.0 或未完成三件套时一次补齐。

**发版类型**：v1.10.0 → **v1.10.1**（若现网仍为 v1.8.0，本批等同合并完成至 v1.10.1）  
**代码分支**：GitLab `main`  
**提交号**：`{{COMMIT}}`  
**GitHub 版本 / 标签**：`v1.10.1`（`package.json`=`1.10.1`）  
**建议顺序**：同步代码 → 后端脚本（SQL 可跳过 + Functions）→ 环境变量（本版跳过）→ **重建前端（必做）** → 验收

---

## 本次上线内容

| 版本/范围 | 主要变化 |
|-----------|----------|
| **v1.10.1 前端** | 工作台「发送详情」展示出站附件预览/下载；发送日志与工作台详情弹窗过高时可滚动 |
| **v1.10.1 组件** | 抽取 `SendLogDetailAttachments`，发送日志与工作台共用 |
| **累计后端（v1.10.0）** | 出站附件归档 `sent/` + Storage RLS；`send-reply` 归档逻辑（已上线则跳过 SQL / 仅同步 Functions） |

**本批注意**：

| # | 组件 | 说明 |
|---|------|------|
| 1 | **前端重建（必做）** | 无本版前端则工作台详情仍无「发出附件」、弹窗可能无法滚动 |
| 2 | Edge `send-reply` + migration（累计） | 若 v1.10.0 已完整上线可自动跳过 SQL；未上线则本脚本一并补齐 |

历史说明（非升版补齐稿，已由本版取代）：`docs/ops-hotfix-v1.10.0-outbound-attachment-preview.md`

---

## 研发需单独提供（不进 Git）

| 材料 | 用途 |
|------|------|
| 生产 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | **必须**重建前端镜像（须指向生产 Kong，非 localhost / 测试库） |
| 无新增 Functions 密钥 | 本版不强制改 `.env.functions` |

**发版清单** `mail-guide-ai-main/deploy/backend-release.env` **已在 Git**，Jenkins rsync `deploy/` 后自动下发，运维**无需**向研发另要该文件。

清单核对（与仓库一致）：

```text
RELEASE_VERSION="v1.10.1"
MIGRATIONS=(
  "20260804120000_outbound_attachments_sent_archive_rls.sql"
)
RUN_APPLY_VAULT_AND_CRON="false"
APPLY_FUNCTIONS="true"
BACKUP_FUNCTIONS="true"
```

> **禁止**将 `APPLY_FUNCTIONS` 设为 `false`（若现网尚未具备出站归档 Functions）。本版**必须**重建并发布前端。

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
- `mail-guide-ai-main/supabase/`（含 `migrations/` 与 `functions/`）
- `mail-guide-ai-main/deploy/`（含 `backend-release.env`）
- 若现网使用附件 Worker：另含 `docker-compose.worker.yml` 与 `scripts/workers/`（本版不改 Worker 配置）

**注意**：不要同步含真实密码的 `.env` / `.env.functions`。

rsync 后当场核对：

```bash
cat /data/temp/mail-guide-ai-main/deploy/backend-release.env | head -40
```

确认 `RELEASE_VERSION="v1.10.1"`，且 `MIGRATIONS` / `APPLY_FUNCTIONS` 与上文一致。

---

### 第 2 步：执行后端发版脚本

**目的**：按清单执行（或跳过已执行的）出站归档 RLS，同步 Edge Functions 并重启 functions。

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
- 期望结尾：`OK: backend release applied`

**禁止**：全量重跑整个 `supabase/migrations/` 目录。

**本次 SQL 清单（以 Git 中 `MIGRATIONS` 为准）**：

- `20260804120000_outbound_attachments_sent_archive_rls.sql`（累计；v1.10.0 已执行则跳过）

---

### 第 3 步：配置环境变量

**目的**：本版无强制新增 / 变更 Functions 环境变量。

**操作**：**跳过**。不要求修改 `.env.functions`（第 2 步脚本会按需重建 functions）。

> 若现网附件补拉仍异常，与本版无关；对照历史发版（如 v1.7.4）的 Edge 限额与 Worker，勿在本步擅自改无关项。

---

### 第 4 步：部署前端（必做）

**目的**：上线工作台出站附件预览与详情弹窗滚动；发送日志侧共用同一附件组件。

**操作**：使用研发提供的生产 `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY` **重新 build 并部署**前端镜像（须为生产 Kong，非 localhost/测试库）。

> 只发后端不发前端 = 工作台详情仍无「发出附件」、弹窗滚动未修复；本步不可跳过。

---

### 第 5 步：验收

**目的**：确认发版成功。

**操作**：

```bash
cd /data/service/supabase-selfhost

docker compose ps functions db

# 1) migration 记录（累计 SQL；版本列可能为 v1.10.0 或本批写入）
docker compose exec -T db psql -U postgres -d postgres -c \
  "SELECT filename, release_version, applied_at FROM ops.backend_release_migrations ORDER BY applied_at DESC LIMIT 10;"

# 2) Storage RLS 策略存在
docker compose exec -T db psql -U postgres -d postgres -c \
  "SELECT polname FROM pg_policy WHERE polrelid = 'storage.objects'::regclass AND polname = '员工可读已发送出站附件归档';"

# 3) 归档相关代码已在运行时 volumes
grep -n "archiveOutboundAttachments\|buildSentArchivePath" \
  volumes/functions/_shared/outbound-attachment.ts \
  volumes/functions/send-reply/index.ts | head -40

docker compose logs functions --tail 50

export REPO_ROOT=/data/service/cs-main
export SELFHOST_ROOT=/data/service/supabase-selfhost
bash "$REPO_ROOT/mail-guide-ai-main/scripts/linux/post-deploy-verify.sh"
```

**通过标准**：

| 检查项 | 标准 |
|--------|------|
| 容器 | `functions`、`db` 为 Up |
| migration / RLS | 存在策略名 `员工可读已发送出站附件归档`；ops 表可见该 SQL 文件名 |
| 代码 | volumes 中存在 `archiveOutboundAttachments` |
| 日志 | 无持续报错 |
| 前端 | 能登录；**发送日志**与**工作台往来发送详情**均有「发出附件」；详情过高可滚动 |
| 业务冒烟 | **新发**一封带图片附件 → 两处详情可预览；Storage 有 `sent/{mailbox_id}/{send_log_id}/...` |

**发版后请通知业务**：

| 角色 | 动作 |
|------|------|
| 客服 / 业务 | 抽测：带附件手工回复 → 发送日志详情预览；工作台「同发件人往来」打开发送详情看附件 |
| 说明 | 发版前未归档的历史日志可能无法预览，属预期；以新发送为准 |

---

## 步骤一览

| 步 | 目的 | 动作 |
|----|------|------|
| 1 | 代码到位 | Jenkins rsync（含 `deploy/backend-release.env`） |
| 2 | 后端上线 | `apply-backend-release.sh`（累计 SQL 可跳过 + Functions） |
| 3 | 环境变量 | 跳过（无强制改 `.env.functions`） |
| 4 | 页面更新 | **前端重建并部署（必做）** |
| 5 | 确认 OK | 查 migration / RLS / volumes / 工作台+发送日志冒烟 |

---

## 禁止事项

- 勿将 `.env.functions`、生产密钥提交 Git 或打进 Jenkins 包
- 勿全量重跑 migrations 目录
- 勿删除 `volumes/functions/` 下的 `hello`、`main`
- 勿只发后端、跳过第 4 步前端重建
- 勿将附件 Worker 的 `SUPABASE_URL` 设为 `http://127.0.0.1:8000`；勿依赖 `/tmp/*-override.yml`
- 勿把前端 `VITE_*` 指到测试库 / localhost

---

## 异常联系

第 2 步脚本报错或 functions 持续异常：停止操作，保存脚本输出与 `docker compose logs functions`，联系研发。

**研发对接人**：________  
**运维负责人**：________  
**计划发版时间**：________
