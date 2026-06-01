# mail-guide-ai v1.3.0 上线说明（请运维按序执行）

> 研发发版文档 · 对应 Git 标签 `v1.3.0` · 模板见 `docs/ops-release-notice-template.md`

**发版类型**：v1.2.2 → **v1.3.0**  
**代码分支**：GitLab `main`  
**提交号**：`8cbe548b1275cc14a1e026e8a987de7c866fb076`（标签 `v1.3.0`，含 `142eee8` 主功能提交）  
**建议顺序**：同步代码 → 后端脚本 → 环境变量（含邮件体积上限）→ 前端重新构建部署 → 验收

---

## 本次上线内容

| 版本/范围 | 主要变化 |
|-----------|----------|
| **v1.3.0 后端** | 新增 4 条 migration；同步 Edge Functions（含 `erp-notify-customer`、`run-email-attachment-repair-tasks` 等）；`RUN_APPLY_VAULT_AND_CRON=true` 更新 pg_cron（正文/附件补拉经 Kong） |
| **ERP 拦截通知** | 接口 **必填 `site_code`**，发件邮箱按「站点邮箱关联」解析；422 写发送日志且不占用幂等键 |
| **附件补拉** | `email_attachment_repair_tasks` 队列 + 定时任务，解决超大附件 Worker 超时 |
| **邮件同步体积** | `.env.functions` 配置 `MAIL_SYNC_FULL_BODY_MAX_BYTES`、`MAIL_SYNC_FULL_BODY_WITH_ATTACH_MAX_BYTES`（见第 3 步） |
| **前端** | 工作台附件展示/下载、分阶段同步增强、邮箱配置页优化；迅捷回邮模板「站点邮箱关联」、发送日志 |
| **对 ERP 的 Breaking** | 拦截客户通知须增加字段 `site_code`（无需传 `site_name`），详见 `mail-guide-ai-main/docs/erp-notify-customer-api.md` |

---

## 研发需单独提供（不进 Git）

| 材料 | 用途 |
|------|------|
| 生产 `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY` | 前端 Jenkins 构建（须为生产 Kong 地址，非 localhost/测试库） |
| **`MAIL_SYNC_FULL_BODY_MAX_BYTES`**、**`MAIL_SYNC_FULL_BODY_WITH_ATTACH_MAX_BYTES`** | 邮件同步/补拉 RFC822 体积上限（字节）；须写入现网 `.env.functions`（本次建议 8MB / 65MB，见第 3 步） |
| `ERP_NOTIFY_API_KEY` | 仅当现网 `.env.functions` **尚未配置** 时由研发提供；已配置则本步仅核对，勿覆盖 |

**发版清单** `mail-guide-ai-main/deploy/backend-release.env` **已在 Git**，Jenkins rsync `deploy/` 后自动下发，运维**无需**向研发另要该文件。

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

**目的**：把发版脚本、SQL、清单同步到服务器。

**操作**：rsync 到 `/data/temp/mail-guide-ai-main/`，须包含：

- `mail-guide-ai-main/scripts/`
- `mail-guide-ai-main/supabase/`
- `mail-guide-ai-main/deploy/`（含 `backend-release.env`）

**注意**：不要同步含真实密码的 `.env.functions`（勿用研发本机或仓库外的 `.env` 覆盖现网）。

---

### 第 2 步：执行后端发版脚本

**目的**：执行数据库迁移、更新 Edge Functions、按需更新 cron、重启 functions。

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
- `RUN_APPLY_VAULT_AND_CRON=true`：执行 `apply-vault-and-cron.sh`，将业务 cron（含 `run-email-body-repair-tasks`、`run-email-attachment-repair-tasks`）指向栈内 `http://kong:8000`
- 同步业务 Edge Functions（**保留 `hello`、`main`**）

**禁止**：全量重跑整个 `supabase/migrations/` 目录。

**本次 SQL 清单（以 Git 中 `MIGRATIONS` 为准）**：

| 文件名 | 说明（供对照） |
|--------|----------------|
| `20260527140000_email_body_repair_tasks.sql` | 正文补拉队列表（v1.2.2 若已执行则跳过） |
| `20260527140100_cron_email_body_repair_tasks.sql` | 正文补拉 cron（同上） |
| `20260527143000_email_attachment_repair_tasks.sql` | **v1.3.0** 附件补拉队列表 |
| `20260527143100_cron_email_attachment_repair_tasks.sql` | **v1.3.0** 附件补拉 cron |
| `20260527143200_selfhost_cron_repair_tasks_kong.sql` | **v1.3.0** 自建：正文/附件补拉 cron 改 Kong |
| `20260527200000_erp_site_mailboxes.sql` | **v1.3.0** ERP 站点与发件邮箱关联表 |

---

### 第 3 步：配置环境变量（本次必做）

**目的**：加载 v1.3.0 邮件体积上限配置，并确认 ERP 鉴权仍可用。

**操作**：

1. 编辑 `/data/service/supabase-selfhost/.env.functions`
2. **新增或更新**以下变量（字节，须为正整数）：

```bash
# sync-mailbox：完整 RFC822 拉取上限（说明见 mail-guide-ai-main/docs/self-hosted-env-functions.example）
MAIL_SYNC_FULL_BODY_MAX_BYTES=8000000
MAIL_SYNC_FULL_BODY_WITH_ATTACH_MAX_BYTES=65000000
```

| 变量 | 含义 | 未配置时默认 | **本次建议值** |
|------|------|-------------|----------------|
| `MAIL_SYNC_FULL_BODY_MAX_BYTES` | 无附件邮件：超过 RFC822.SIZE 则只取 `BODY[TEXT]` | 5000000（5MB） | **8000000（8MB）** |
| `MAIL_SYNC_FULL_BODY_WITH_ATTACH_MAX_BYTES` | BODYSTRUCTURE 已标有附件时，允许整封拉取的上限 | 25000000（25MB） | **65000000（65MB）** |

3. 确认 **`ERP_NOTIFY_API_KEY`** 仍存在且非空（v1.1+ 一般已配置，勿删除）
4. 重建 functions：

```bash
cd /data/service/supabase-selfhost
docker compose up -d --force-recreate --no-deps functions
```

**说明**：

- 过小会导致大邮件/含附件邮件只拉正文摘要、附件无法入库，需依赖附件补拉队列；本次上调是为减少「只摘要、无附件」情况。
- 上限越大，单次 IMAP FETCH 占用内存与时间越高；若 functions 出现 `WorkerRequestCancelled` 或 OOM，可适当下调 `WITH_ATTACH` 值，超大信仍由 `email_attachment_repair_tasks` 后台处理。
- **勿**将 `.env.functions` 提交 Git 或打入 Jenkins 包。

---

### 第 4 步：部署前端（本次有前端变更）

**目的**：更新工作台、迅捷回邮模板、发送日志等页面。

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
  "SELECT to_regclass('public.erp_site_mailboxes') AS erp_site_mailboxes, to_regclass('public.email_attachment_repair_tasks') AS attachment_repair;"

docker compose exec -T db psql -U postgres -d postgres -c \
  "SELECT jobname, schedule FROM cron.job WHERE jobname LIKE '%repair%' ORDER BY jobname;"

docker compose exec functions printenv MAIL_SYNC_FULL_BODY_MAX_BYTES MAIL_SYNC_FULL_BODY_WITH_ATTACH_MAX_BYTES

docker compose logs functions --tail 30
```

可选（仓库完整同步时）：

```bash
export REPO_ROOT=/data/service/cs-main
export SELFHOST_ROOT=/data/service/supabase-selfhost
bash /data/temp/mail-guide-ai-main/scripts/linux/post-deploy-verify.sh
```

**通过标准**：

| 检查项 | 标准 |
|--------|------|
| 容器 | `functions`、`db` 为 Up |
| 迁移台账 | 本次 4 条 v1.3.0 SQL 在 `ops.backend_release_migrations` 中可见（或显示已跳过因已存在） |
| 表 | `erp_site_mailboxes`、`email_attachment_repair_tasks` 存在 |
| cron | 存在 `email-body-repair-tasks-every-3min`、`email-attachment-repair-tasks-every-5min`（或等价 jobname） |
| 邮件体积配置 | `MAIL_SYNC_FULL_BODY_MAX_BYTES` 为 `8000000`；`MAIL_SYNC_FULL_BODY_WITH_ATTACH_MAX_BYTES` 为 `65000000`（或与研发书面约定值一致） |
| Functions 卷 | 含 `erp-notify-customer`、`run-email-attachment-repair-tasks`；保留 `hello`、`main` |
| 日志 | `functions` 无持续报错 |
| 前端 | 能登录；工作台可打开邮件；「迅捷回邮模板」可见「站点邮箱关联」 |

**发版后请通知业务**：

| 角色 | 动作 |
|------|------|
| **客服管理员** | 在「迅捷回邮模板 → 站点邮箱关联」为每个 ERP 会传的 `site_code` 配置发件邮箱与站点名称；发件邮箱须在「邮箱配置」中完成 SMTP |
| **迅捷 ERP** | 拦截客户通知接口 **必须增加 `site_code`**，与客服系统站点编码一致；**无需传 `site_name`**；未配置站点将返回 422，修复配置后可用同一 `idempotency_key` 重试 |
| **客服一线** | 超大附件邮件可稍后刷新工作台查看；ERP 拦截通知发送记录类型为「ERP 拦截通知」，可查看站点编码/名称 |

---

## 步骤一览

| 步 | 目的 | 动作 |
|----|------|------|
| 1 | 代码到位 | Jenkins rsync（含 `deploy/backend-release.env`） |
| 2 | 后端上线 | `apply-backend-release.sh` |
| 3 | 环境变量 | 写入 `MAIL_SYNC_FULL_BODY_*`（8MB/65MB），核对 `ERP_NOTIFY_API_KEY`，重建 functions |
| 4 | 页面更新 | 重新 build 并部署前端镜像 |
| 5 | 确认 OK | 查容器/迁移表/cron/环境变量/日志；通知业务配置站点与 ERP 加 `site_code` |

---

## 禁止事项

- 勿将 `.env.functions`、生产密钥提交 Git 或打进 Jenkins 包
- 勿全量重跑 `supabase/migrations/` 目录
- 勿删除 `volumes/functions/` 下的 `hello`、`main`
- 勿用含 `*.supabase.co` 的云端 cron URL 覆盖自建 Kong 地址（本版脚本会按清单处理）
- 勿在未更新 `MAIL_SYNC_FULL_BODY_*` 的情况下仅发后端/前端，否则现网仍用旧默认（5MB/25MB），大附件行为与研发验收不一致

---

## 异常联系

第 2 步脚本报错或 `functions` 持续异常：**停止后续操作**，保存脚本完整输出与 `docker compose logs functions`，联系研发。

**研发对接人**：________  
**运维负责人**：________  
**计划发版时间**：________
