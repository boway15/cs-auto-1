# mail-guide-ai v1.7.4 上线说明（请运维按序执行）

> 研发发版文档 · 对应 `RELEASE_VERSION=v1.7.4` · 模板见 `docs/ops-release-notice-template.md`

**发版类型**：v1.7.3 → **v1.7.4**  
**代码分支**：GitLab `main`  
**提交号**：`4f52f3f0385378159b546640ee022bbe8f15819a`（文档 tip：`8c9e04c`）  
**建议顺序**：同步代码 → 后端脚本（Functions）→ 环境变量（核对 Edge 限额）→ 启动 Docker 附件 Worker → 前端（跳过）→ 验收

---

## 本次上线内容

| 版本/范围 | 主要变化 |
|-----------|----------|
| **v1.7.4 后端 Functions** | 附件补拉取消 HTTP 套娃（进程内 IMAP）；每轮少 part + 约 45s 续传；Edge CPU/取消类失败拉长 `next_run_at` |
| **Docker Worker** | 新增 `email-attachment-repair-worker`（**生产强烈建议启动**，稳定修复「待补拉」附件） |
| **发版脚本** | `apply-backend-release.sh` 兼容 CentOS 7 空 `MIGRATIONS=()` |
| **数据库** | 无新增 migration（`MIGRATIONS=()`） |
| **前端** | 无 |

---

## 研发需单独提供（不进 Git）

| 材料 | 用途 |
|------|------|
| 无新增密钥 | 本版不新增 `.env.functions` 必填项 |
| 现网 Kong 可达地址 | 启 Docker Worker 时配置 `SUPABASE_URL`（勿用本机 `host.docker.internal` 默认值） |

**发版清单** `mail-guide-ai-main/deploy/backend-release.env` **已在 Git**，Jenkins rsync `deploy/` 后自动下发，运维**无需**向研发另要该文件。

清单要点（务必核对）：

```text
RELEASE_VERSION="v1.7.4"
MIGRATIONS=()
RUN_APPLY_VAULT_AND_CRON="false"
APPLY_FUNCTIONS="true"
BACKUP_FUNCTIONS="true"
```

> 若 `APPLY_FUNCTIONS=false`，会漏发附件相关 Functions，**禁止**。

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

**目的**：把发版脚本、Functions、清单同步到服务器。

**操作**：rsync 到 `/data/temp/mail-guide-ai-main/`，须包含：

- `mail-guide-ai-main/scripts/`（含 `linux/selfhosted/apply-backend-release.sh`、`workers/email-attachment-repair-worker.ts`）
- `mail-guide-ai-main/supabase/`（含 functions）
- `mail-guide-ai-main/deploy/`（含 `backend-release.env`）
- `mail-guide-ai-main/docker-compose.worker.yml`

**注意**：不要同步含真实密码的 `.env` / `.env.functions`。

---

### 第 2 步：执行后端发版脚本

**目的**：按清单同步 Edge Functions 并重建 `functions` 容器（本版无 SQL、不开 vault/cron）。

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

- `MIGRATIONS=()`：打印 `No migrations listed` 后应继续 Sync Functions（本版脚本已修 CentOS7 空数组问题）
- 期望结尾：`OK: backend release applied`
- 抽查：

```bash
grep -n "repairEmailAttachmentsById\|partial_resume\|MIGRATIONS\[@\]+" \
  /data/service/supabase-selfhost/volumes/functions/_shared/imap-attachment-repair.ts \
  /data/temp/mail-guide-ai-main/scripts/linux/selfhosted/apply-backend-release.sh \
  /data/service/supabase-selfhost/volumes/functions/run-email-attachment-repair-tasks/index.ts | head
```

---

### 第 3 步：环境变量

**目的**：无新增必填项；核对 Edge 限额，并准备 Worker 的 `SUPABASE_URL`。

**操作 A — `.env.functions`（核对即可，已达标可跳过写入）**：

```bash
grep -E 'EDGE_CPU_TIME|EDGE_WORKER_TIMEOUT|EDGE_MEMORY|MAIL_ATTACHMENT_REPAIR_BATCH' \
  /data/service/supabase-selfhost/.env.functions
```

建议值（未达标则改完重建 functions）：

| 变量 | 建议值 |
|------|--------|
| `EDGE_CPU_TIME_SOFT_LIMIT_MS` | `60000` |
| `EDGE_CPU_TIME_HARD_LIMIT_MS` | `120000` |
| `EDGE_WORKER_TIMEOUT_MS` | `150000` |
| `EDGE_MEMORY_LIMIT_MB` | `256` |
| `MAIL_ATTACHMENT_REPAIR_BATCH_LIMIT` | `1`（保持） |

若有修改：

```bash
cd /data/service/supabase-selfhost
docker compose up -d --force-recreate --no-deps functions
```

**操作 B — Docker 附件 Worker（生产强烈建议，见第 4 步一并启动）**  
需保证 Worker 环境能读到 `SUPABASE_SERVICE_ROLE_KEY`（或 `SERVICE_ROLE_KEY`），且 **`SUPABASE_URL` 指向现网 Kong**（不是 `host.docker.internal`）。

---

### 第 4 步：前端 + Docker 附件 Worker

**前端**：**跳过**（本版无前端变更）。

**Docker 附件 Worker（必做推荐）**：

```bash
cd /data/temp/mail-guide-ai-main
# 若代码亦在 /data/service/cs-main/mail-guide-ai-main，用实际路径

# 现网示例：与 supabase 同机/同网络时指向 Kong（按实际网络调整）
export SUPABASE_URL=http://kong:8000

docker compose -f docker-compose.worker.yml up -d email-attachment-repair-worker
docker compose -f docker-compose.worker.yml ps email-attachment-repair-worker
docker compose -f docker-compose.worker.yml logs --tail 80 email-attachment-repair-worker
```

**说明**：

- `docker-compose.worker.yml` 默认 `SUPABASE_URL=http://host.docker.internal:8000` 仅适合本机联调  
- 现网须覆盖为可达 Kong；密钥通常来自 compose 的 `env_file`（`../supabase-selfhost/.env` 与 `.env.functions`），路径不对时请运维按现网目录改 `env_file` 或导出变量  
- Worker 日志出现 `[att-worker] started` 即为正常  

---

### 第 5 步：验收

**目的**：确认 Functions / Worker 可用，问题邮件附件可落库。

**操作**：

```bash
cd /data/service/supabase-selfhost
docker compose ps functions db
docker compose logs functions --tail 30
```

对问题邮件（示例 id：`2708b75c-4572-4d63-9859-8ef16acd7b24`）执行：

```sql
UPDATE email_attachment_repair_tasks
SET status = 'pending',
    next_run_at = now(),
    locked_at = null,
    locked_by = null,
    last_error = 'post_v174_verify',
    attempt_count = 0
WHERE email_id = '2708b75c-4572-4d63-9859-8ef16acd7b24';
```

等待数分钟（3 个小附件、Worker 每轮约 1～2 个 part）后：

```sql
SELECT left(attachments::text, 800)
FROM emails
WHERE id = '2708b75c-4572-4d63-9859-8ef16acd7b24';

SELECT status, attempt_count, last_error, next_run_at, updated_at
FROM email_attachment_repair_tasks
WHERE email_id = '2708b75c-4572-4d63-9859-8ef16acd7b24';
```

**通过标准**：

| 检查 | 期望 |
|------|------|
| `apply-backend-release` | `OK: backend release applied`，无 `MIGRATIONS[@]: unbound` |
| `functions` 容器 | Up；volumes 含 `imap-attachment-repair` |
| 附件 Worker | 容器 Up；日志有 `[att-worker] started` / 处理结果 |
| 问题邮件 `attachments` | 出现 `filename` / `storage_path`（非仅 `count`+占位 note） |
| 补拉任务 | `status=resolved` |
| 工作台 | 该邮件附件可预览/下载 |

**发版后通知业务**：抽查 1～2 封「待补拉」含图附件邮件，确认可下载；超大视频类仍可能入队慢，属预期。

---

## 步骤一览

| 步 | 目的 | 动作 |
|----|------|------|
| 1 | 代码到位 | rsync `scripts/`、`supabase/`、`deploy/`、`docker-compose.worker.yml` |
| 2 | 后端上线 | `apply-backend-release.sh`（Functions only） |
| 3 | 环境变量 | 核对 Edge 限额；准备 Worker 的 `SUPABASE_URL` |
| 4 | Worker / 前端 | 启 `email-attachment-repair-worker`；**跳过前端** |
| 5 | 确认 OK | compose / Worker 日志 / 问题邮件 SQL + 工作台 |

---

## 禁止事项

- 禁止全量重跑 `supabase/migrations/`
- 禁止将 `APPLY_FUNCTIONS` 设为 `false`
- 禁止只发前端、不发 Functions
- 禁止生产长期只靠 Edge cron、不启 Docker 附件 Worker（仍可能偶发 CPU 硬杀）
- 禁止用本机 `.env` / `.env.functions` 覆盖现网密钥

---

## 异常联系

脚本报错或验收未出现 `storage_path`：保留终端输出、`functions` 与 `email-attachment-repair-worker` 日志，联系研发：______________
