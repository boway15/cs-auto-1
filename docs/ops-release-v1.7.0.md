# mail-guide-ai v1.7.0 上线说明（请运维按序执行）

> 研发发版文档 · 对应 `RELEASE_VERSION=v1.7.0` · 模板见 `docs/ops-release-notice-template.md`

**发版类型**：v1.6.0 → **v1.7.0**  
**代码分支**：GitLab `main`  
**提交号**：`810f5bb21b1c4445efd9764a009df3932e8894b6`  
**建议顺序**：同步代码 → 后端脚本（仅 Functions）→ 环境变量（本次无新增）→ 前端（本次跳过）→ 验收

---

## 本次上线内容

| 版本/范围 | 主要变化 |
|-----------|----------|
| **v1.7.0 后端** | 无新增 migration；同步 Edge Functions（`sync-mailbox`、`run-email-attachment-repair-tasks`、`_shared/imap-bodystructure`） |
| **入站附件** | 用户附件数与 Gmail 对齐（user/inline）；去掉 count≥3 占位门闸；大邮件仅按 RFC822.SIZE；补拉错误透传 |

---

## 研发需单独提供（不进 Git）

| 材料 | 用途 |
|------|------|
| 无新增密钥 | 本版不改 `.env.functions` 必填项；现网已有配置即可 |

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

**注意**：不要同步含真实密码的 `.env.functions`。

---

### 第 2 步：执行后端发版脚本

**目的**：按清单更新 Edge Functions（本版无 SQL、不开 vault/cron），并重启 functions。

**操作**：

```bash
chmod +x /data/temp/mail-guide-ai-main/scripts/linux/selfhosted/*.sh \
         /data/temp/mail-guide-ai-main/scripts/linux/*.sh

bash /data/temp/mail-guide-ai-main/scripts/linux/selfhosted/apply-backend-release.sh \
  /data/temp/mail-guide-ai-main \
  /data/service/supabase-selfhost \
  /data/temp/mail-guide-ai-main/deploy/backend-release.env
```

**清单要点**（Git 中已写明）：

- `RELEASE_VERSION="v1.7.0"`
- `MIGRATIONS=()`（无新增 SQL）
- `RUN_APPLY_VAULT_AND_CRON="false"`
- `APPLY_FUNCTIONS="true"` / `BACKUP_FUNCTIONS="true"`

**说明**：已执行过的 migration 会自动跳过；本版清单为空，脚本主要做 Functions 备份与替换（保留 `hello`、`main`）。

---

### 第 3 步：环境变量

**目的**：确认无需新增 `.env.functions` 项。

**操作**：本次**跳过**写入；若曾手工调过同步体积类变量，可保持现网值不变。本版代码内默认增量 auto 内联上限已改为 3MB，无需强制改 env。

---

### 第 4 步：前端

**目的**：无前端发版。

**操作**：本次**跳过**（勿因本版单独 rebuild 前端镜像，除非与其它变更一并上线）。

---

### 第 5 步：验收

**目的**：确认 Functions 已更新且服务健康。

**操作**：

```bash
cd /data/service/supabase-selfhost
docker compose ps functions db
docker compose exec -T db psql -U postgres -d postgres -c \
  "SELECT filename, release_version, applied_at FROM ops.backend_release_migrations ORDER BY applied_at DESC LIMIT 10;"
docker compose exec -T db psql -U postgres -d postgres -c \
  "SELECT jobname, schedule FROM cron.job ORDER BY jobname;"
docker compose logs functions --tail 50

export REPO_ROOT=/data/service/cs-main
export SELFHOST_ROOT=/data/service/supabase-selfhost
bash "$REPO_ROOT/mail-guide-ai-main/scripts/linux/post-deploy-verify.sh"
```

**通过标准**：

| 检查 | 期望 |
|------|------|
| `functions` 容器 | Up |
| 发版脚本 | 成功结束；Functions 备份与替换无报错 |
| cron | 与发版前一致（本版未改 vault/cron） |
| 业务抽查 | 含用户附件邮件的 `attachments.count` 与客户端一致；大附件仍按体积入队补拉 |

**发版后通知业务**：可抽查 1～2 封「仅内嵌图 / 含真实附件」邮件，确认列表附件数与能否下载。

---

## 步骤一览

| 步 | 目的 | 动作 |
|----|------|------|
| 1 | 代码到位 | rsync `scripts/`、`supabase/`、`deploy/` |
| 2 | 后端上线 | `apply-backend-release.sh`（Functions only） |
| 3 | 环境变量 | 本次跳过 |
| 4 | 页面更新 | 本次跳过 |
| 5 | 确认 OK | compose / logs / `post-deploy-verify.sh` |

---

## 禁止事项

- 禁止全量重跑 `supabase/migrations/`
- 禁止用本机 `.env` / `.env.functions` 覆盖现网密钥
- 禁止删除运行时 `hello`、`main` Functions 目录
- 禁止 force push / 跳过发版脚本手搓覆盖 volumes

---

## 异常联系

脚本报错即停发版，保留终端输出与 `functions` 日志，联系研发：______________
