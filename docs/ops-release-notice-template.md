# mail-guide-ai {{VERSION}} 上线说明（请运维按序执行）

> 模板：`docs/ops-release-notice-template.md`  
> 由研发/运维角色按本次发版填写 `{{...}}` 后发给运维。Agent 输出须遵循 `.cursor/agents/mail-guide-ops.md` 中「运维发版文档标准」。

**发版类型**：{{FROM_VERSION}} → **{{VERSION}}**  
**代码分支**：GitLab `{{BRANCH}}`  
**提交号**：`{{COMMIT}}`  
**建议顺序**：{{RELEASE_ORDER}}

---

## 本次上线内容

| 版本/范围 | 主要变化 |
|-----------|----------|
| {{CHANGELOG_ROWS}} |

---

## 研发需单独提供（不进 Git）

| 材料 | 用途 |
|------|------|
| {{SECRETS_ROWS}} |

**发版清单** `mail-guide-ai-main/deploy/backend-release.env` **已在 Git**，Jenkins rsync `deploy/` 后自动下发，运维无需另要文件。

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
- `RUN_APPLY_VAULT_AND_CRON={{RUN_CRON}}`：{{CRON_NOTE}}
- 同步业务 Edge Functions（**保留 `hello`、`main`**）

**禁止**：全量重跑整个 `supabase/migrations/` 目录。

**本次 SQL 清单（以 Git 中 `MIGRATIONS` 为准）**：

{{MIGRATIONS_LIST}}

---

### 第 3 步：配置环境变量（若本次需要）

**目的**：{{ENV_STEP_PURPOSE}}

**操作**：

1. 编辑 `/data/service/supabase-selfhost/.env.functions`
2. {{ENV_STEP_DETAILS}}
3. 重建 functions：

```bash
cd /data/service/supabase-selfhost
docker compose up -d --force-recreate --no-deps functions
```

{{ENV_STEP_EXTRA}}

---

### 第 4 步：部署前端（若本次有前端变更）

**目的**：更新页面功能。

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

docker compose logs functions --tail 30
```

**通过标准**：

| 检查项 | 标准 |
|--------|------|
| 容器 | `functions`、`db` 为 Up |
| 日志 | 无持续报错 |
| 前端 | 能登录、能打开工作台 |
| {{EXTRA_CHECKS}} |

**发版后请通知业务**：

| 角色 | 动作 |
|------|------|
| {{BUSINESS_ROWS}} |

---

## 步骤一览

| 步 | 目的 | 动作 |
|----|------|------|
| 1 | 代码到位 | Jenkins rsync（含 `deploy/backend-release.env`） |
| 2 | 后端上线 | `apply-backend-release.sh` |
| 3 | 环境变量 | {{STEP3_SUMMARY}} |
| 4 | 页面更新 | {{STEP4_SUMMARY}} |
| 5 | 确认 OK | 查容器/日志；{{STEP5_SUMMARY}} |

---

## 禁止事项

- 勿将 `.env.functions`、生产密钥提交 Git 或打进 Jenkins 包
- 勿全量重跑 migrations 目录
- 勿删除 `volumes/functions/` 下的 `hello`、`main`

---

## 异常联系

第 2 步脚本报错或 functions 持续异常：停止操作，保存脚本输出与 `docker compose logs functions`，联系研发。

**研发对接人**：________  
**运维负责人**：________  
**计划发版时间**：________
