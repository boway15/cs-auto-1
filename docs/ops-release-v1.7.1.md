# mail-guide-ai v1.7.1 上线说明（请运维按序执行）

> 研发发版文档 · 对应 `RELEASE_VERSION=v1.7.1` · 模板见 `docs/ops-release-notice-template.md`

**发版类型**：v1.7.0 → **v1.7.1**  
**代码分支**：GitLab `main`  
**提交号**：`3b0afecef334ea73be6a9616e59f5468fe06a9b2`  
**建议顺序**：同步代码 → 后端脚本（migration + vault/cron）→ 环境变量（本次跳过）→ 前端（本次跳过）→ 验收

---

## 本次上线内容

| 版本/范围 | 主要变化 |
|-----------|----------|
| **v1.7.1 后端** | 取消 pg_cron 定时自动生成草稿（`auto-draft-every-30min`）；同步 vault/cron 脚本，不再注册该任务 |
| **人工能力** | 人工 `generate-draft` / 工作台生成草稿**不受影响** |
| **Functions** | 本版无 Edge Functions 代码变更（`APPLY_FUNCTIONS=false`） |

---

## 研发需单独提供（不进 Git）

| 材料 | 用途 |
|------|------|
| 无新增密钥 | 本版不改 `.env.functions`；现网已有配置即可 |

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
- `mail-guide-ai-main/supabase/`（含本次 migration）
- `mail-guide-ai-main/deploy/`（含 `backend-release.env`）

**注意**：不要同步含真实密码的 `.env.functions`。

---

### 第 2 步：执行后端发版脚本

**目的**：执行取消自动草稿的 migration，并运行 vault/cron 同步（**必须**），确保 job 被卸载且不会被脚本重新注册。

**操作**：

```bash
chmod +x /data/temp/mail-guide-ai-main/scripts/linux/selfhosted/*.sh \
         /data/temp/mail-guide-ai-main/scripts/linux/*.sh

bash /data/temp/mail-guide-ai-main/scripts/linux/selfhosted/apply-backend-release.sh \
  /data/temp/mail-guide-ai-main \
  /data/service/supabase-selfhost \
  /data/temp/mail-guide-ai-main/deploy/backend-release.env
```

**清单要点**（Git 中已写明，务必核对）：

- `RELEASE_VERSION="v1.7.1"`
- `MIGRATIONS=("20260714120000_unschedule_auto_draft_cron.sql")`
- `RUN_APPLY_VAULT_AND_CRON="true"`（**必须为 true**；若为 false，仅跑 migration 后若有人手工重跑旧 vault 脚本仍可能把 job 加回——本版脚本已去掉注册，仍须走一遍 apply-vault）
- `APPLY_FUNCTIONS="false"` / `BACKUP_FUNCTIONS="false"`（本版无 Functions 变更）

**本次 SQL 清单**：

- `20260714120000_unschedule_auto_draft_cron.sql`（`cron.unschedule('auto-draft-every-30min')`）

**说明**：已执行过的 migration 会自动跳过；`RUN_APPLY_VAULT_AND_CRON=true` 会按更新后的脚本注册其余业务 cron，并对 `auto-draft-every-30min` 执行 unschedule。

**禁止**：全量重跑整个 `supabase/migrations/` 目录；禁止在未更新脚本的情况下用旧版 `apply-vault-and-cron` 覆盖 cron。

---

### 第 3 步：环境变量

**目的**：确认无需新增 `.env.functions` 项。

**操作**：本次**跳过**写入与重建 functions（本版 `APPLY_FUNCTIONS=false`，发版脚本也不会替换 Functions 目录）。

---

### 第 4 步：前端

**目的**：无前端发版。

**操作**：本次**跳过**（勿因本版单独 rebuild 前端镜像）。

---

### 第 5 步：验收

**目的**：确认 migration / vault-cron 已生效，且 `auto-draft-every-30min` 已不在 cron 中。

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
docker compose logs functions --tail 50

export REPO_ROOT=/data/service/cs-main
export SELFHOST_ROOT=/data/service/supabase-selfhost
bash "$REPO_ROOT/mail-guide-ai-main/scripts/linux/post-deploy-verify.sh"
```

**通过标准**：

| 检查 | 期望 |
|------|------|
| `ops.backend_release_migrations` | 出现 `20260714120000_unschedule_auto_draft_cron.sql`，`release_version` 为 `v1.7.1`（或等价记录） |
| `auto-draft-every-30min` | `count(*) = 0`（已不在 `cron.job`） |
| 其它业务 cron | 仍在（如 mailbox sync、compensation、repair 等，与现网策略一致） |
| 业务抽查 | 工作台 / 人工 generate-draft 仍可手动生成草稿 |

**发版后通知业务**：线上不再定时自动生成草稿；需要草稿时由客服在工作台或走人工 generate-draft。

---

## 步骤一览

| 步 | 目的 | 动作 |
|----|------|------|
| 1 | 代码到位 | rsync `scripts/`、`supabase/`、`deploy/` |
| 2 | 后端上线 | `apply-backend-release.sh`（**migration + RUN_APPLY_VAULT_AND_CRON=true**） |
| 3 | 环境变量 | 本次跳过 |
| 4 | 页面更新 | 本次跳过 |
| 5 | 确认 OK | 验收 SQL：`auto-draft-every-30min` 不存在 + `post-deploy-verify.sh` |

---

## 禁止事项

- 禁止全量重跑 `supabase/migrations/`
- 禁止用本机 `.env` / `.env.functions` 覆盖现网密钥
- 禁止将 `RUN_APPLY_VAULT_AND_CRON` 改回 `false` 后发版（本版必须同步 vault/cron 脚本）
- 禁止用未更新的旧版 vault/cron 脚本覆盖现网（会把 auto-draft 重新注册回来）

---

## 异常联系

脚本报错即停发版，保留终端输出与 `db`/`functions` 日志，联系研发：______________
