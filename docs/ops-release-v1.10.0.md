# mail-guide-ai v1.10.0 上线说明（请运维按序执行）

> 研发发版文档 · 对应 `RELEASE_VERSION=v1.10.0` · 现网自 v1.8.0 同批合并（含 v1.9.0）· 模板见 `docs/ops-release-notice-template.md`  
> **测试环境已验证通过**（出站附件发送详情预览）；本文档供**现网 / 生产机房（线下）**按序发版。

**发版类型**：v1.8.0 → **v1.10.0**  
**代码分支**：GitLab `main`  
**提交号**：`91cfede90c59308f8d2e2cc582b65584ee1a1827`（含出站归档 RLS 兼容自建 storage 属主；功能标签 tip `v1.10.0`=`b170e68`）  
**GitHub 版本 / 标签**：`v1.10.0`（`package.json`=`1.10.0`；中间标签 `v1.9.0` 已并入本批，勿另开一轮）  
**建议顺序**：同步代码 → 后端脚本（SQL + Functions）→ 环境变量（本版跳过）→ **重建前端** → 验收

---

## 本次上线内容

| 版本/范围 | 主要变化 |
|-----------|----------|
| **v1.9.0 后端** | MIME 正文选段：Gmail 回复引用感知；跳过 `message/rfc822` 嵌入原文；纯手机签名不视为完整正文 |
| **v1.9.0 前端** | 工作台发件人展示/列表身份隔离；往来记录详情切换修复 |
| **v1.10.0 后端 + Storage** | 发送成功后出站附件归档 `sent/{mailbox_id}/{send_log_id}/...`；临时附件清理；员工可读归档 RLS |
| **v1.10.0 前端** | 发送日志（SendLogs）详情「发出附件」签名预览/下载 |

**本批三件套缺一不可**（测试已验）：

| # | 组件 | 不发的典型后果 |
|---|------|----------------|
| 1 | 前端重建（含 SendLogs「发出附件」） | 详情无预览入口 |
| 2 | Edge `send-reply` + `_shared/outbound-attachment` | 发完即删临时文件，Storage 无 `sent/` 归档 |
| 3 | Migration `20260804120000_outbound_attachments_sent_archive_rls.sql` | 详情能列附件但签名 URL 失败、无法预览 |

---

## 研发需单独提供（不进 Git）

| 材料 | 用途 |
|------|------|
| 生产 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | 前端镜像构建（须指向生产 Kong，非 localhost / 测试库） |
| 无新增 Functions 密钥 | 本版不强制改 `.env.functions` |

**发版清单** `mail-guide-ai-main/deploy/backend-release.env` **已在 Git**，Jenkins rsync `deploy/` 后自动下发，运维**无需**向研发另要该文件。

清单核对（与仓库一致）：

```text
RELEASE_VERSION="v1.10.0"
MIGRATIONS=(
  "20260804120000_outbound_attachments_sent_archive_rls.sql"
)
RUN_APPLY_VAULT_AND_CRON="false"
APPLY_FUNCTIONS="true"
BACKUP_FUNCTIONS="true"
```

> **禁止**将 `APPLY_FUNCTIONS` 设为 `false`。本版**必须**重建并发布前端。

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
- 若现网使用附件 Worker：另含 `docker-compose.worker.yml` 与 `scripts/workers/`（与 v1.7.4/v1.8.0 一致，本版不改 Worker 配置）

**注意**：不要同步含真实密码的 `.env` / `.env.functions`。

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
- v1.9.0 无新 SQL，但仍须跑本脚本以同步 Functions（含 MIME 选段等）

**禁止**：全量重跑整个 `supabase/migrations/` 目录。

**本次 SQL 清单（以 Git 中 `MIGRATIONS` 为准）**：

- `20260804120000_outbound_attachments_sent_archive_rls.sql`

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

**目的**：更新工作台发件人/往来修复，以及发送日志「发出附件」预览/下载。

**操作**：使用研发提供的生产 `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY` **重新 build 并部署**前端镜像（须为生产 Kong，非 localhost/测试库）。

> 只发后端不发前端 = 业务仍看不到预览入口；本步不可跳过。

---

### 第 5 步：验收

**目的**：确认发版成功。

**操作**：

```bash
cd /data/service/supabase-selfhost

docker compose ps functions db

# 1) migration 已记入 ops
docker compose exec -T db psql -U postgres -d postgres -c \
  "SELECT filename, release_version, applied_at FROM ops.backend_release_migrations ORDER BY applied_at DESC LIMIT 10;"

# 2) Storage RLS 策略存在（员工可读 sent/ 归档）
docker compose exec -T db psql -U postgres -d postgres -c \
  "SELECT polname FROM pg_policy WHERE polrelid = 'storage.objects'::regclass AND polname = '员工可读已发送出站附件归档';"

# 3) 确认归档相关代码已同步到运行时 volumes
grep -n "archiveOutboundAttachments\|buildSentArchivePath" \
  volumes/functions/_shared/outbound-attachment.ts \
  volumes/functions/send-reply/index.ts | head -40

grep -n "multipart/alternative\|message/rfc822\|selectBestTextPart" \
  volumes/functions/_shared/mime-parse.ts | head -40

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
| migration | `ops.backend_release_migrations` 可见 `20260804120000_outbound_attachments_sent_archive_rls.sql` / `v1.10.0` |
| RLS | `pg_policy` 存在策略名 `员工可读已发送出站附件归档` |
| 代码 | volumes 中存在 `archiveOutboundAttachments`；`mime-parse` 含引用感知选段逻辑 |
| 日志 | 无持续报错 |
| 前端 | 能登录、能打开工作台与发送日志；详情有「发出附件」 |

**业务冒烟（发版后通知业务）**：

| 场景 | 通过标准 |
|------|----------|
| Gmail 引用回复 | 工作台正文优先显示客户新回复，不被嵌入原文/引用淹没 |
| 发件人/往来 | 列表发件人身份正确；切换往来详情不串单 |
| 带附件回复 | 发送成功后 Storage 出现 `sent/{mailbox_id}/{send_log_id}/...`；发送日志详情可预览/下载 |
| 权限 | 无该邮箱权限的员工不能访问对应归档附件 |
| 旧日志 | 发送时尚无归档的历史记录：提示不可访问即可，整页不崩 |

**发版后请通知业务**：

| 角色 | 动作 |
|------|------|
| 客服/业务 | 抽测 Gmail 引用正文；抽测工作台发件人；抽测「带附件回复 → 发送日志预览」 |
| 研发 | 跟进归档失败个案（functions 日志中 `outbound attachment archive failed`）及仍异常的正文个案 |

---

## 步骤一览

| 步 | 目的 | 动作 |
|----|------|------|
| 1 | 代码到位 | Jenkins rsync（含 `deploy/backend-release.env`） |
| 2 | 后端上线 | `apply-backend-release.sh`（migration + Functions） |
| 3 | 环境变量 | 跳过（无强制改 `.env.functions`） |
| 4 | 页面更新 | **前端重建并部署（必做）** |
| 5 | 确认 OK | 查 migration / RLS / volumes 代码 / 业务冒烟 |

---

## 禁止事项

- 勿将 `.env.functions`、生产密钥提交 Git 或打进 Jenkins 包
- 勿全量重跑 migrations 目录
- 勿删除 `volumes/functions/` 下的 `hello`、`main`
- 勿只发前端或只发 Functions、跳过本版 migration（会出现「能见附件名但预览失败」）
- 勿将附件 Worker 的 `SUPABASE_URL` 设为 `http://127.0.0.1:8000`（容器内应使用 `http://supabase-kong:8000`，见 `docker-compose.worker.yml`）
- 勿依赖 `/tmp/*-override.yml` 补网络或 URL

---

## 常见漏项（对照）

| 漏项 | 现象 | 处理 |
|------|------|------|
| 未跑 migration | 详情有附件列表，签名预览 403/失败 | 确认第 2 步成功；查 `ops.backend_release_migrations` 与 `pg_policy` |
| 未同步 `send-reply` | 新发送后 Storage 无 `sent/`，仅临时路径被删 | 核对 `APPLY_FUNCTIONS=true` 并重跑第 2 步；grep volumes 归档函数 |
| 未重建前端 | 无「发出附件」预览 UI | 执行第 4 步，核对生产 `VITE_*` |
| 前端仍指向测试库 | 页面连错环境 | 重建镜像时改用生产 Kong URL/Key |
| 用旧 `backend-release.env` | `MIGRATIONS=()` 或版本号不对 | rsync 后 `cat .../deploy/backend-release.env` 与上文清单一致 |
| 历史发送日志无归档 | 旧数据无法预览 | 预期行为；仅新发送会归档；整页不崩即可 |

---

## 异常联系

第 2 步脚本报错或 functions 持续异常：停止操作，保存脚本输出与 `docker compose logs functions`，联系研发。

**研发对接人**：________  
**运维负责人**：________  
**计划发版时间**：________
