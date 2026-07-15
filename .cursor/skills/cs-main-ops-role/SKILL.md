---
name: cs-main-ops-role
description: cs-main 运维角色技能：提交前变更归类、禁止误提交数据卷与密钥、维护 backend-release.env、Jenkins 发版步骤、Docker 附件/正文 Worker、.env.functions 与 post-deploy 验收。用户说提交、commit、发版、上线、release、运维、验收、backend-release、Jenkins、发运维发版文档、附件补拉、Worker、fetch failed 时使用；与 /mail-guide-ops 子代理配合。
cursor_skill_id: 738fa62b-ab57-4661-baa3-0de121ff839a
---

# cs-main 运维角色（提交 + 发版）

与 `.cursor/agents/mail-guide-ops.md` 子代理内容一致；用户可用 **`/mail-guide-ops`** 显式调用子代理，或在对话中说「用运维角色检查本次提交/发版」「输出发版文档给运维」。

## 何时启用

| 场景 | 动作 |
|------|------|
| 准备 `git commit` | 模式 A：变更归类 + 禁提交项 + commit message + 是否需改 `backend-release.env` |
| 准备上线 / Jenkins | 模式 B：核对清单 + 线上脚本 + 验收 SQL/compose/logs |
| **输出运维发版文档** | **模式 C：按「运维发版文档标准」生成可转发全文（中文简体）** |
| 发版后故障 | 对照 `docs/ops-post-deploy-checklist.md` 漏项表 |

## 变更 → 发版动作映射

| 变更类型 | 清单字段 / 动作 |
|----------|-----------------|
| 新 migration | 写入 `deploy/backend-release.env` 的 `MIGRATIONS`；跨版本升级时列**累计未执行** SQL |
| 无 SQL | `MIGRATIONS=()` |
| cron/vault 变更 | `RUN_APPLY_VAULT_AND_CRON="true"` |
| 改 Functions | `APPLY_FUNCTIONS="true"`（默认） |
| 仅前端 | Jenkins 前端 Pipeline；核对 `VITE_SUPABASE_*` |
| 改 `.env.functions` | 运维手工写入 `supabase-selfhost/.env.functions` 并重建 `functions`（不进 Git） |
| Docker Worker（附件/正文补拉） | rsync 须含 `docker-compose.worker.yml` + `scripts/workers/`；现网启 Worker（配置已在 yml，勿 `/tmp` override） |

## 现网踩坑清单（v1.7.4 附件补拉实战，必读）

发版文档 / 排障 Worker 时对照；细节与命令见 `mail-guide-ai-ops` 技能「Docker Worker」。

| # | 踩坑 | 正确做法 |
|---|------|----------|
| 1 | 大附件只靠 Edge cron | 生产启 `email-attachment-repair-worker`；Edge 易 CPU/墙钟硬杀 |
| 2 | 改了限额却不 recreate `functions` | `.env.functions` 改完必须 `up -d --force-recreate --no-deps functions` |
| 3 | Worker 用 `SUPABASE_URL=http://127.0.0.1:8000` | 容器内指自身 → `fetch failed`；现网用 **`http://supabase-kong:8000`**（已写在 `docker-compose.worker.yml`） |
| 4 | `export SUPABASE_URL=...` 指望盖过 compose | **无效**（yml `environment` 写死优先）；改 yml 或 compose 变量插值 |
| 5 | `host.docker.internal` 用在 CentOS | Desktop 可用；Linux 现网常无效 |
| 6 | `/data/temp` 下找不到 `../supabase-selfhost/.env` | `ln -sfn /data/service/supabase-selfhost /data/temp/supabase-selfhost`（勿复制密钥） |
| 7 | Worker 未加入 Kong 网络 | yml 挂外部网 **`supabase_default`**（`docker network ls \| grep supabase` 核对名） |
| 8 | 依赖 `/tmp/att-worker-override.yml` | **禁止**；URL/网络一律进 `docker-compose.worker.yml` |
| 9 | 日志 `processed:0` 就当失败 | API 已通；队列无到期任务时正常——验收前把任务 `pending` + `next_run_at=now()` |
| 10 | `mail-ca.pem` NotFound | 有 `bundled 163 mail CA` 即兜底生效，不挡发版 |

**附件验收通过形态**：`attachments` 含 `filename`+`storage_path`；任务 `status=resolved`；Worker 日志可出现 `stored:N`。示例问题邮件曾用 id `2708b75c-4572-4d63-9859-8ef16acd7b24`。

**.env.functions 附件相关建议值**（发版要求改 env 时写入第 3 步）：

```text
EDGE_CPU_TIME_SOFT_LIMIT_MS=60000
EDGE_CPU_TIME_HARD_LIMIT_MS=120000
EDGE_WORKER_TIMEOUT_MS=150000
EDGE_MEMORY_LIMIT_MB=256
MAIL_ATTACHMENT_REPAIR_BATCH_LIMIT=1
```

## 禁止提交（常见误操作）

- `supabase-selfhost/volumes/db/data/**`
- `**/dump.rdb`、`dify/docker/volumes/**`
- 含生产密钥的 `.env` / `.env.functions`（模板用 `.example`）

## 本地 Docker：单条 migration（研发自测，非线上发版）

线上仍只跑 `apply-backend-release.sh` + `MIGRATIONS`；**本地验证一条 SQL** 时优先：

```powershell
cd d:\Docker\project\cs-main\supabase-selfhost
docker compose cp "d:\Docker\project\cs-main\mail-guide-ai-main\supabase\migrations\<文件名>.sql" db:/tmp/mig.sql
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f /tmp/mig.sql
```

| 踩坑 | 处理 |
|------|------|
| `db push` + `<POSTGRES_PASSWORD>` 占位符 | 用 `.env` 真实密码 |
| 连 `127.0.0.1:54323` refused | 本仓库 **`db` 端口为 15432**，见 `DEPLOY.md` 第六节 |
| `Get-Content \| psql` + 中文 COMMENT | 改用 **`docker compose cp` + `psql -f`**；`ALTER` 已成功可忽略 COMMENT 失败 |

详见：`mail-guide-ai-main/docs/self-hosted-supabase.md`「四步：数据库迁移」、`DEPLOY.md` 第六节。

## 关键文件

- 清单：`mail-guide-ai-main/deploy/backend-release.env`（**在 Git，Jenkins rsync，运维不需另要**）
- 发版文档模板：`docs/ops-release-notice-template.md`
- 脚本：`mail-guide-ai-main/scripts/linux/selfhosted/apply-backend-release.sh`
- 验收：`mail-guide-ai-main/scripts/linux/post-deploy-verify.sh`
- 文档：`docs/backend-release-automation.md`

## 运维发版文档标准（模式 C，必遵守）

用户要求「发版文档 / 上线说明 / 发给运维」时，**必须**按下列结构输出**完整 Markdown**（可直接复制到 IM/邮件），不要只给零散命令。

### 编写前（研发侧）

1. 读取当前 `mail-guide-ai-main/deploy/backend-release.env` 与 `git log -1`。
2. 若现网跨版本升级（如 v1.0→v1.2），`MIGRATIONS` 须含**累计**未执行 SQL，并已 push Git。
3. 列出需运维**手工**配置、且**不进 Git** 的项（如 `ERP_NOTIFY_API_KEY`、`VITE_*`）。

### 文档结构（固定章节，顺序不变）

1. **标题**：`# mail-guide-ai {版本} 上线说明（请运维按序执行）`
2. **元信息**：发版类型、分支、提交号、建议顺序（默认：同步代码 → 后端脚本 → 环境变量 → 前端 → 验收）
3. **本次上线内容**：简短表格（版本/能力）
4. **研发需单独提供（不进 Git）**：仅密钥、前端构建参数等；**明确** `backend-release.env` 随 Git/rsync，无需另要
5. **服务器路径**：三行标准路径表
6. **执行步骤**（每步 **目的** + **操作**，共 5 步）：
   - 第 1 步：Jenkins rsync（`scripts/`、`supabase/`、`deploy/`；含 Worker 时加 `docker-compose.worker.yml`）
   - 第 2 步：`apply-backend-release.sh`（含完整 bash；说明 SQL 自动跳过；列出 Git 中 `MIGRATIONS` 文件名）
   - 第 3 步：`.env.functions`（仅本次需要的变量；**本次必改则写强制 recreate**，不要写「核对即可可跳过」）
   - 第 4 步：前端（若有变更）和/或 Docker Worker（含软链 `.env` + 仅用主 yml 启动，**勿**教运维写 `/tmp` override）
   - 第 5 步：验收命令 + 通过标准表 + **发版后通知业务**表
7. **步骤一览**：5 行总表（步 | 目的 | 动作）
8. **禁止事项**：3～4 条（含禁止 Worker 用 `127.0.0.1`、禁止跳过 env recreate）
9. **异常联系**：脚本报错停发版 + 留联系人占位

### 不要写入运维文档的内容

- 不要求运维「事先查 `ops.backend_release_migrations`」（脚本会自动跳过已执行 SQL）
- 不要让运维「向研发另要 `backend-release.env` 文件」（应在 Git/rsync）
- 不要冗长架构说明、不要开发实现细节
- 不要让运维依赖 `/tmp/*-override.yml` 补网络或 `SUPABASE_URL`（应在仓库 `docker-compose.worker.yml`）

### 步骤 3 常见环境变量提示

| 变量 | 何时写入第 3 步 |
|------|------------------|
| `ERP_NOTIFY_API_KEY` | 含 `erp-notify-customer` 或 v1.1+ 首次上线 |
| `EDGE_CPU_*` / `EDGE_WORKER_TIMEOUT_MS` / `EDGE_MEMORY_LIMIT_MB` / `MAIL_ATTACHMENT_REPAIR_BATCH_LIMIT` | 附件补拉 / Edge 资源发版（如 v1.7.4）；**强制修改 + recreate** |
| 其它 `ERP_*` / `DIFY_*` | 仅当本次变更或研发明确要核对 |

详细步骤与输出格式见子代理 `mail-guide-ops`；执行时优先输出 **模式 C 完整发版文档**，提交检查用模式 A/B。
