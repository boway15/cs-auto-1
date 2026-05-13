# 自建 Supabase（Docker）与 mail-guide-ai 对接

本文说明如何在自有服务器或本机用 **官方 Docker 模板** 跑全套 Supabase，并让 **mail-guide-ai** 前端与 Edge Functions 指向该实例。权威说明以官方文档为准：[Self-Hosting with Docker](https://supabase.com/docs/guides/self-hosting/docker)。

**重要**：自建 **并非** 放弃 Edge Functions。mail-guide-ai 的 **IMAP/SMTP、process-email、定时调度函数等仍在 Supabase Edge Functions（Deno）** 内实现，与 Supabase Cloud 上的运行时模型一致；自建只是 Postgres/Auth/Kong/**Functions 运行时** 改为你自己的 Docker 栈，源码仍是仓库里的 `mail-guide-ai-main/supabase/functions/`。

## 架构关系

- **API 网关（Kong）** 默认对外 `http://<主机>:8000`：REST、Auth、Storage、Realtime、Studio、**Edge Functions** 均经此入口。
- **mail-guide-ai 前端** 的 `VITE_SUPABASE_URL` 应设为该入口（生产环境为 HTTPS 域名）。
- **Edge Functions** 在自建栈中由官方 **`functions` 服务**（Deno）加载，磁盘路径一般为 `supabase-selfhost/volumes/functions/`。与云端通过 CLI `supabase functions deploy` 上传不同，本仓库通常通过 **同步同一套 TS 源码 + 重启 `functions` 容器** 发布（见下文「五步：同步 Edge Functions」）。

## 资源与前置

| 项目 | 说明 |
|------|------|
| 内存 | 官方建议至少 4GB，生产建议 8GB+ |
| Docker | Docker Engine / Docker Desktop |
| Git | 用于拉取官方 `docker/` 模板 |
| 密钥生成 | 官方脚本为 shell，**Windows 可用 Git Bash 或 WSL** 执行 `utils/generate-keys.sh` |

## 一步：生成官方 Docker 目录

在 **PowerShell** 中（已安装 Git）：

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main\scripts
.\bootstrap-supabase-docker.ps1
```

将在 **`cs-main/supabase-selfhost/`** 下得到与官方一致的 `docker-compose.yml`、`utils/`、`volumes/` 等。请勿把 **`supabase-selfhost/.env`** 提交到 Git（仓库根 `.gitignore` 已忽略）。

若脚本提示目录已存在，需重装时请自行备份 `.env` 后删除 `supabase-selfhost` 再执行。

## 二步：配置密钥与 URL

1. 复制环境模板：`supabase-selfhost/.env.example` → `.env`。
2. 在 **Git Bash 或 WSL** 中进入 `supabase-selfhost`，执行官方脚本（见官方文档 *Configuring and securing*）：
   - `sh ./utils/generate-keys.sh`
   - 若使用新版非对称密钥：`sh ./utils/add-new-auth-keys.sh`
3. 按官方说明检查 `.env`，至少确认：
   - **`SUPABASE_PUBLIC_URL`**：外网访问网关的基址，如 `http://你的域名:8000` 或内网 `http://服务器IP:8000`。
   - **`API_EXTERNAL_URL`**：与对外 Auth/回调一致，通常与 `SUPABASE_PUBLIC_URL` 相同。
   - **`SITE_URL`**：浏览器里打开 **mail-guide-ai 工作台** 的地址，如 `http://localhost:8080` 或生产 `https://app.example.com`。
   - **`DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`**：Studio 基础认证，**不能使用纯数字密码**。
   - **`FUNCTIONS_VERIFY_JWT`**：与 `mail-guide-ai` 的 `supabase/config.toml` 中 `verify_jwt = false` 的函数一致时，自建侧常设为 `false`；生产请配合网关限制来源 IP 或独立密钥，见项目 README 安全说明。

生产环境应在网关前加 **HTTPS 反向代理**（Caddy / Nginx 等），见官方 [Configure HTTPS](https://supabase.com/docs/guides/self-hosting/self-hosted-proxy-https)。

## 三步：启动栈

```powershell
cd d:\Docker\project\cs-main\supabase-selfhost
docker compose pull
docker compose up -d
docker compose ps
```

健康检查均为 `healthy` 后，浏览器访问 `SUPABASE_PUBLIC_URL`（如 `http://localhost:8000`）应出现 Studio 登录。

### 宿主机 5432 已被占用（`Bind for 0.0.0.0:5432 failed`）

`supabase-pooler`（Supavisor）默认把 **会话模式** 映射到宿主机 **5432**，与本机已有 Postgres、`mail-guide-ai-main/docker-compose.local.yml` 等冲突。

**不要**把 `.env` 里的 `POSTGRES_PORT` 改成别的数字：它表示容器内访问 `db:5432`，必须保持 **5432**。

本仓库推荐做法（已与官方模板略有差异时）：

1. 在 `supabase-selfhost/.env` 增加或修改：**`POOLER_PORT_PUBLISHED=54322`**（或任意空闲端口）。
2. 在 `supabase-selfhost/docker-compose.yml` 的 `supavisor` 服务里，把 `ports` 第一行改为 **`${POOLER_PORT_PUBLISHED:-5432}:5432`**（仅改宿主机映射，不改内部连接）。
3. 执行 `docker compose up -d`。

从宿主机用 **psql / `db push`** 连池化 Postgres 时，请使用 **`POOLER_PORT_PUBLISHED`**（如 `54322`），而不是 5432。

### Windows：Kong / Pooler 因 CRLF 启动失败

若 Kong 日志出现 `kong-entrypoint.sh: no such file or directory`，或 Pooler 报 `unexpected token: carriage return`，说明挂载进容器的脚本为 **CRLF**。在 PowerShell 中执行：

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main\scripts
.\fix-supabase-selfhost-crlf.ps1
cd d:\Docker\project\cs-main\supabase-selfhost
docker compose up -d --force-recreate kong supavisor
```

## 四步：数据库迁移（mail-guide-ai）

自建库是空库，需要应用 `mail-guide-ai-main/supabase/migrations/` 下的 SQL。

### 推荐：临时暴露 `db` 的 5432 到宿主机（便于 `db push`）

Supavisor 会话端口（如 `POOLER_PORT_PUBLISHED=54322`）的用户名格式为 `postgres.<POOLER_TENANT_ID>`，**不适合**直接当 `supabase db push` 的 URL。最省事的做法是给 **`db` 容器** 临时加端口映射：

1. 编辑 `supabase-selfhost/docker-compose.yml`，在 **`db`** 服务下增加（与 `healthcheck` 同级）：

```yaml
    ports:
      - "54323:5432"
```

2. 重启 db（或整栈）：

```powershell
cd d:\Docker\project\cs-main\supabase-selfhost
docker compose up -d db
```

3. 从 `supabase-selfhost/.env` 读取 **`POSTGRES_PASSWORD`**，执行迁移：

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main
npx supabase db push --db-url "postgresql://postgres:<POSTGRES_PASSWORD>@127.0.0.1:54323/postgres"
```

4. **迁移完成后**删除上述 `ports` 块并再次 `docker compose up -d`，避免 Postgres 长期暴露在宿主机。

### 四步续：Vault + pg_cron 指向自建 Kong（必做）

迁移里的 cron 仍指向 **Supabase Cloud** URL，且 vault 里 `service_role_key` 可能是占位 JWT。迁移成功后在本机执行（需栈已启动、`db` 容器可 `exec`）：

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main\scripts\selfhosted
.\Apply-VaultAndCron.ps1
```

默认将 cron 的 `net.http_post` 目标设为 **`http://kong:8000/functions/v1/...`**（与 `db`、Kong 在同一 Docker 网络内）。若数据库不在该网络，可传 `-KongInternalUrl` 为实际可达的网关地址。

脚本会注册 **5 条**定时任务（均为 `Authorization: Bearer` + `vault.decrypted_secrets.service_role_key`）：

| jobname | schedule | Edge Function |
|---------|----------|----------------|
| `auto-sync-mailbox-every-5min` | `*/4 * * * *` | `sync-mailbox` |
| `auto-draft-every-30min` | `2-59/4 * * * *` | `schedule-draft-generation` |
| `compensating-alerts-every-30min` | `15 * * * *` | `schedule-compensating-alerts` |
| `run-compensation-tasks-every-30min` | `14 * * * *` | `run-compensation-tasks` |
| `retry-risk-intercept-hourly-at-45` | `45 * * * *` | `retry-risk-intercept-compensation` |

**注意**：不要把 Cloud 的 cron URL 留在生产自建库中，否则定时任务会打到云端。

**与 migrations 的关系**：`supabase/migrations` 里部分历史文件仍含 `*.supabase.co` 的 cron URL；**自建生产以本脚本为准**——每次执行 `Apply-VaultAndCron.ps1` 会用上表五条任务覆盖同名 job，并把 vault 中的 `service_role_key` 与 `supabase-selfhost/.env` 的 `SERVICE_ROLE_KEY` 对齐。仅 `db push`、未跑脚本时，cron 可能仍指向云端，须补跑脚本。

## 五步：同步 Edge Functions

自建实例从 **`volumes/functions`** 加载函数，入口服务为官方自带的 **`main`** 目录，**不要删除 `main`**。

在 PowerShell 中：

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main\scripts
.\sync-functions-to-selfhost.ps1
cd d:\Docker\project\cs-main\supabase-selfhost
docker compose restart functions --no-deps
```

### Functions 环境变量（Dify、邮件等）

云端 Secrets 在自建中需自行注入。推荐流程：

1. 一键为 `functions` 服务追加 `env_file: .env.functions`（仅需执行一次；会改你本机 `supabase-selfhost/docker-compose.yml`）：

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main\scripts\selfhosted
.\Ensure-FunctionsEnvFileInCompose.ps1
```

2. 将 **[`self-hosted-env-functions.example`](./self-hosted-env-functions.example)** 复制为 **`supabase-selfhost/.env.functions`**，按与云端 `npx supabase functions secrets set` 相同的语义填写 `DIFY_*`、**`ERP_*`**（OAuth2 与 OMS/网关 Base URL，见 [`erp-order-api.md`](./erp-order-api.md)）等（勿提交 Git）。

3. 重建 functions 容器：

```powershell
cd d:\Docker\project\cs-main\supabase-selfhost
docker compose up -d --force-recreate --no-deps functions
```

详见：[Self-Hosted Functions](https://supabase.com/docs/guides/self-hosting/self-hosted-functions)。

## 六步：配置 mail-guide-ai 前端

复制 **[`.env.selfhosted.example`](../.env.selfhosted.example)** 为 **`mail-guide-ai-main/.env`**（或与现有 `.env` 合并），将 `VITE_SUPABASE_PUBLISHABLE_KEY` 填为 **`supabase-selfhost/.env` 中的 `ANON_KEY`**（若启用新密钥体系则用 `SUPABASE_PUBLISHABLE_KEY`）。

要点：

```env
VITE_SUPABASE_URL=http://<你的网关主机>:8000
VITE_SUPABASE_PUBLISHABLE_KEY=<ANON_KEY>
VITE_SUPABASE_PROJECT_ID=self-hosted
```

`VITE_SUPABASE_PROJECT_ID` 在本仓库前端中主要用于构建期占位，可填任意固定字符串（如 `self-hosted`）。

然后：

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main
npm run build
# 或
docker compose build
docker compose up -d
```

## 七步：Dify / 定时任务 / 外调

- **Dify**：Edge Functions 若需回调 Dify，仍使用公网可达的 Dify 地址；把原 Supabase Secrets 中的 URL/Key 写入 `.env.functions`。
- **pg_cron**：完成 **「四步续」** 后，库内应有上表 **4 个** `jobname`，且 `command` 中 URL 指向栈内 Kong（如 `http://kong:8000/functions/v1/...`），**不得**出现 `*.supabase.co`。在 Studio → SQL 或 `psql` 中核对：

```sql
SELECT jobname, schedule, LEFT(command, 120) AS command_preview
FROM cron.job
WHERE jobname IN (
  'auto-sync-mailbox-every-5min',
  'auto-draft-every-30min',
  'compensating-alerts-every-30min',
  'run-compensation-tasks-every-30min'
)
ORDER BY jobname;
```

预期 4 行；若缺 `run-compensation-tasks-every-30min`，说明未用最新脚本跑过「四步续」，请重新执行 `Apply-VaultAndCron.ps1`。
- **从外网访问 Functions**：确保 Kong 的 8000（或 443 反代）对调用方可达，且防火墙放行。

## 推荐执行顺序（小结）

1. 三步：启动自建栈（含 Windows CRLF / 5432 冲突处理见上文）。
2. 四步：临时 `db` 端口 **`54323:5432`** → `supabase db push` → 去掉端口映射。
3. 四步续：**`scripts/selfhosted/Apply-VaultAndCron.ps1`**（vault + cron）。
4. 五步：**`sync-functions-to-selfhost.ps1`** → **`Ensure-FunctionsEnvFileInCompose.ps1`** → 填写 **`.env.functions`** → 重建 `functions`。
5. 六步：前端 **`.env`**（见 `.env.selfhosted.example`）。
6. 七步：按需启动 Dify / ngrok 等。

## 本地从零到可用：总清单（逐项核对）

> 上文「一步～七步」按**概念模块**组织；本节按**你实际在 PowerShell 里该做的顺序**写，便于首次搭栈打印或逐项打勾。默认根路径 **`d:\Docker\project\cs-main`**，自建目录 **`supabase-selfhost`**，前端 **`mail-guide-ai-main`**。细节命令与截图级说明仍以本节之后的 **「本地手动操作详解」** 为准。

### 0. 开始前（避免做到一半才发现缺东西）

| 检查项 | 怎么确认 | 不通过时 |
|--------|----------|----------|
| Docker Desktop 已运行 | `docker version` 无报错 | 先启动 Docker |
| 本机 **5432** 是否已被占用 | PowerShell：`netstat -ano`，查 `LISTENING` 是否占用 **5432** | 在 **`supabase-selfhost/.env`** 设 **`POOLER_PORT_PUBLISHED=54322`**，并按上文改 `docker-compose.yml` 里 supavisor 的宿主机端口映射 |
| 已安装 **Git**（跑官方 `generate-keys.sh`） | `git --version` | 安装 Git for Windows，或用 WSL |
| 前端需要 **Node** | `node -v`、`npm -v` | 安装 LTS Node |
| 若要用 AI 链路 | 备好 Dify 工作流 **URL + API Key** | 可先不配，但「分析/草稿」会失败 |

建议单独开一个记事本，在生成 **`supabase-selfhost/.env`** 后立刻复制保存：**`POSTGRES_PASSWORD`**、**`ANON_KEY`**、**`SERVICE_ROLE_KEY`**（后续 Studio、前端、排错都会用到）。

### 1. 生成官方 compose 目录（仅首次或重装）

| 步骤 | 命令 / 位置 | 成功标志 | 常见失败 |
|------|-------------|----------|----------|
| 1.1 | `cd d:\Docker\project\cs-main\mail-guide-ai-main\scripts` → `.\bootstrap-supabase-docker.ps1` | **`cs-main\supabase-selfhost\`** 下出现 `docker-compose.yml`、`utils/` | 目录已存在：备份 `.env` 后删除整个 `supabase-selfhost` 再执行 |

### 2. 密钥与 `.env`（Studio 能登录的前提）

| 步骤 | 做什么 | 成功标志 | 常见失败 |
|------|--------|----------|----------|
| 2.1 | 复制 **`supabase-selfhost/.env.example`** → **`.env`** | 文件存在且非空 | — |
| 2.2 | 在 **Git Bash 或 WSL** 中进入 `supabase-selfhost`，执行 `sh ./utils/generate-keys.sh`（按需 `add-new-auth-keys.sh`） | `.env` 里 **`JWT_SECRET`**、**`ANON_KEY`**、**`SERVICE_ROLE_KEY`** 等为长串非占位 | 在 PowerShell 里直接跑 `.sh` 失败 → 换 Bash/WSL |
| 2.3 | 人工核对 **`SITE_URL`**（浏览器打开前端的地址，如 `http://localhost:8080`）、**`SUPABASE_PUBLIC_URL`** / **`API_EXTERNAL_URL`**（通常为 `http://localhost:8000` 或你的域名） | 与真实访问 URL 一致 | 登录后跳转错站、OAuth 回调失败 → 多半是这三项不一致 |
| 2.4 | **`DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`**：Studio 登录用；密码**勿纯数字** | 能记住一组账号密码 | Kong/Studio 401 → 检查这两项 |

### 3. 启动栈并确认健康

| 步骤 | 命令 | 成功标志 | 常见失败 |
|------|------|----------|----------|
| 3.1 | `cd d:\Docker\project\cs-main\supabase-selfhost` → `docker compose pull` → `docker compose up -d` → `docker compose ps` | **`db`、`kong`** 等为 **Up**（**healthy** 更佳） | 端口冲突 → 见上文 **5432 / POOLER** |
| 3.2 | 浏览器打开 **`SUPABASE_PUBLIC_URL`**（常为本机 `http://localhost:8000`） | 出现 Studio 登录页 | Kong 日志 `no such file` / `carriage return` → 执行 **`fix-supabase-selfhost-crlf.ps1`** 后 `docker compose up -d --force-recreate kong supavisor` |

### 4. 数据库迁移（`db push`）与临时端口 **54323**

| 步骤 | 做什么 | 成功标志 | 常见失败 |
|------|--------|----------|----------|
| 4.1 | 编辑 **`docker-compose.yml`**，在 **`db`** 服务下增加 **`ports: - "54323:5432"`**，保存后 `docker compose up -d db` | `docker compose ps` 中 db 仍 healthy | `db push` 报连接拒绝 → 确认 54323 已映射且 db 已起 |
| 4.2 | 从 **`supabase-selfhost/.env`** 取 **`POSTGRES_PASSWORD`**，在 **`mail-guide-ai-main`** 执行：<br>`$env:PGSSLMODE = "disable"`<br>`npx supabase db push --db-url "postgresql://postgres:<密码>@127.0.0.1:54323/postgres"` | 命令结束无 Error，迁移全部 Applied | 认证失败 → 密码是否含特殊字符需 URL 编码；是否连错端口 |
| 4.3 | **立刻** 删除 **`db`** 下的临时 **`ports`** 块，再执行 `docker compose up -d` | `docker compose.yml` 中 db 不再暴露 54323 | 勿长期把 Postgres 暴露在宿主机 |

> **何时可以删 54323**：仅在 **`npx supabase db push` 成功之后**。以后若还要对自建库跑新的 migration，可临时再加回 54323、推完再删。

### 5. Vault + pg_cron（必做；否则定时任务仍打云端）

| 步骤 | 命令 | 成功标志 | 常见失败 |
|------|------|----------|----------|
| 5.1 | `cd d:\Docker\project\cs-main\mail-guide-ai-main\scripts\selfhosted` → `.\Apply-VaultAndCron.ps1` | 脚本无报错退出；**前文「七步」**中的 SQL 能查到 **5 条** job | `db` 不在 compose 网络 → 使用 `-KongInternalUrl "http://实际可达:8000"` |
| 5.2 | Studio → SQL 或 `psql` 执行**前文「七步」**里的 **`SELECT ... FROM cron.job WHERE jobname IN (...)`** | **5 行**，且 **`command` 片段中无 `*.supabase.co`**，应为 **`http://kong:8000/...`** 或你传入的内网 Kong | 只有 3 条或 URL 仍是 Cloud → **重新执行**本脚本（老栈升级常见） |

### 6. Edge Functions 源码、`.env.functions`、重建容器

| 步骤 | 命令 / 操作 | 成功标志 | 常见失败 |
|------|-------------|----------|----------|
| 6.1 | `cd ...\mail-guide-ai-main\scripts` → `.\sync-functions-to-selfhost.ps1` | **`supabase-selfhost/volumes/functions/main`** 下能对应到项目里的函数 | 路径错误 → 确认在 `cs-main` 目录结构下执行 |
| 6.2 | `cd ...\scripts\selfhosted` → `.\Ensure-FunctionsEnvFileInCompose.ps1` | **`docker-compose.yml`** 里 **`functions`** 服务含 **`env_file: .env.functions`** | 仅首次需要；已改过 compose 可跳过 |
| 6.3 | 将 **`docs/self-hosted-env-functions.example`** 复制为 **`supabase-selfhost/.env.functions`**，至少按需填写 **`DIFY_*`**、**`LOVABLE_API_KEY`**（若仍用）等 | 文件存在且密钥非空（业务需要项） | 函数日志报缺环境变量 → 对照 example 与 `startup-commands.md` 云端 secrets 列表 |
| 6.4 | 若邮箱测试报 **`UnknownIssuer`** | 生产：配 **`MAIL_TLS_CA_CERT_PATH`**；仅本地：可临时 **`MAIL_LOCAL_TEST_MODE=true`**（见下文 D3.1） | 改完 **必须** 重建 functions |
| 6.5 | `cd ...\supabase-selfhost` → `docker compose up -d --force-recreate --no-deps functions` → `docker compose logs functions --tail 100` | 无持续报错；`curl http://localhost:8000/functions/v1/hello` 约 **200** | 502 → 看 functions 容器日志是否 import 失败 |

### 7. mail-guide-ai 前端 `.env`

| 步骤 | 做什么 | 成功标志 | 常见失败 |
|------|--------|----------|----------|
| 7.1 | 复制 **`mail-guide-ai-main/.env.selfhosted.example`** → **`.env`**（或合并已有文件） | 三行 Supabase 变量已填 | — |
| 7.2 | **`VITE_SUPABASE_URL=http://localhost:8000`**（或你的网关）；**`VITE_SUPABASE_PUBLISHABLE_KEY=`** 粘贴 **`ANON_KEY`**；**`VITE_SUPABASE_PROJECT_ID=self-hosted`** | `npm run dev` 后浏览器能打开工作台 | CORS / Auth → 核对 **`SITE_URL`**、**`ADDITIONAL_REDIRECT_URLS`** |

### 8. 验收最小集（与下文「验证清单」一致）

1. Studio 可登录；`SELECT jobname FROM cron.job` 含 **五条** 业务 job（见「七步」列表）。
2. `curl.exe` 测 Kong 上 **`/functions/v1/hello`** 为 **200**（或你环境等价）。
3. 前端登录无报错；在 Dify 与 `.env.functions` 齐全时，**收信 / 草稿 / 补偿** 各试一条（见产品文档）。

---

## 本地手动操作详解（逐步教程）

以下假设路径为 **`d:\Docker\project\cs-main`**，自建目录为 **`supabase-selfhost`**，前端项目在 **`mail-guide-ai-main`**。若你的盘符不同，请替换路径。

### A. 开始前检查

1. 打开 **Docker Desktop**，确认状态为 **Running**。
2. 在 PowerShell 中：

```powershell
cd d:\Docker\project\cs-main\supabase-selfhost
docker compose ps
```

应看到 **`supabase-db`**、**`supabase-kong`** 等容器为 **Up**（healthy 更佳）。若未启动：

```powershell
docker compose up -d
```

3. 确认已有 **`supabase-selfhost\.env`**（含 `POSTGRES_PASSWORD`、`SERVICE_ROLE_KEY`、`ANON_KEY` 等）。若没有，先按上文「二步」用官方脚本生成密钥。

---

### B. 数据库迁移：`supabase db push`（必做）

迁移会把 `mail-guide-ai-main\supabase\migrations\` 里的表、RLS、cron 等装进自建 Postgres。**不要**用 Supavisor 的 `54322` 做 `db push`（用户名格式不同），请用下面「直连 `db` 容器」的方式。

#### B1. 临时给 `db` 暴露宿主机端口

1. 用编辑器打开 **`d:\Docker\project\cs-main\supabase-selfhost\docker-compose.yml`**。
2. 找到 **`db:`** 服务（`container_name: supabase-db`），在 **`healthcheck:` 同级** 增加 **`ports`**（缩进与 `healthcheck` 一致，均为 4 空格），例如：

```yaml
    ports:
      - "54323:5432"
```

> 若该服务下已有 `ports`，不要重复添加；改用空闲端口（如 54324）并记住。

3. 保存文件后执行：

```powershell
cd d:\Docker\project\cs-main\supabase-selfhost
docker compose up -d db
```

#### B2. 读取数据库密码

打开 **`d:\Docker\project\cs-main\supabase-selfhost\.env`**，找到 **`POSTGRES_PASSWORD=`**，复制等号后的值（不要引号）。

#### B3. 执行迁移

本地 Postgres **无 TLS** 时，Supabase CLI 可能默认走 SSL，出现 **`tls error (server refused TLS connection)`**。请先在同一 PowerShell 会话设置：

```powershell
$env:PGSSLMODE = "disable"
```

再执行（将密码换成你的 `POSTGRES_PASSWORD`）：

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main
npx supabase db push --db-url "postgresql://postgres:你的POSTGRES密码@127.0.0.1:54323/postgres"
```

- 若密码含 `@`、`:` 等特殊字符，建议用脚本读取 `.env` 再拼 URL，或对密码做 URL 编码（`[uri]::EscapeDataString`）。
- 成功时 CLI 会列出并应用迁移；若 **connection refused**，检查 `54323` 是否映射、`db` 容器是否 Up。

#### B4. 去掉临时端口（建议）

迁移成功后，**删除** `docker-compose.yml` 里刚加的 **`ports:` 整段**，再执行：

```powershell
cd d:\Docker\project\cs-main\supabase-selfhost
docker compose up -d db
```

避免 Postgres 长期暴露在宿主机。

---

### C. Vault + pg_cron 指向自建 Kong（必做）

迁移里的 cron 仍可能指向 **Supabase Cloud**；vault 里 **`service_role_key`** 也可能是占位值。在栈运行状态下执行：

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main\scripts\selfhosted
.\Apply-VaultAndCron.ps1
```

- 默认将 Functions URL 设为 **`http://kong:8000/functions/v1/...`**（与 `db` 在同一 Docker 网络内）。
- 若 `db` 不在该 compose 网络，可加参数：  
  `.\Apply-VaultAndCron.ps1 -KongInternalUrl "http://你的网关:8000"`（须从数据库内能访问）。

失败时查看：`docker compose -f d:\Docker\project\cs-main\supabase-selfhost\docker-compose.yml logs db --tail 80`

---

### D. 同步 Edge Functions 与密钥文件（必做）

#### D1. 复制函数源码到自建目录

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main\scripts
.\sync-functions-to-selfhost.ps1
```

#### D2. 确保 compose 加载 `.env.functions`

若从未执行过：

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main\scripts\selfhosted
.\Ensure-FunctionsEnvFileInCompose.ps1
```

脚本会在 **`functions`** 服务加入 **`env_file: .env.functions`**，并在缺失时从示例生成 **`supabase-selfhost\.env.functions`**。

#### D3. 填写 Dify 等环境变量

1. 用编辑器打开 **`d:\Docker\project\cs-main\supabase-selfhost\.env.functions`**。
2. 对照 **`mail-guide-ai-main\docs\self-hosted-env-functions.example`** 与你在 **Supabase Cloud** 上曾配置的 Secrets（或 `docs\startup-commands.md` 里的 `npx supabase functions secrets set` 列表），至少补齐业务需要的项，例如：
   - `DIFY_ANALYZE_URL` / `DIFY_ANALYZE_KEY`
   - `DIFY_DRAFT_URL` / `DIFY_DRAFT_KEY`
   - `DIFY_GATEWAY_API_KEY`（若使用 `dify-gateway`）
   - 若 `generate-draft` 仍走 Lovable：`LOVABLE_API_KEY`
3. **勿**把该文件提交到 Git。

#### D3.1 邮箱 IMAP 证书与本地测试模式（避免 `UnknownIssuer`）

当“添加邮箱 -> 测试连接”报错：

- `invalid peer certificate: UnknownIssuer`

说明 Edge Functions 运行时不信任目标邮箱服务器证书链。请按下面二选一配置：

1. **生产推荐（安全）**：配置 CA 证书链  
   - 将邮箱服务器的根/中间证书保存为 PEM（例如 `mail-ca.pem`）  
   - 放到：`supabase-selfhost/volumes/functions/certs/mail-ca.pem`
   - 在 `supabase-selfhost/.env.functions` 增加：

```env
MAIL_TLS_CA_CERT_PATH=/home/deno/functions/certs/mail-ca.pem
```

> 注意：自建 Edge Runtime 会把用户函数编译到沙箱目录，User Worker 可能无法直接读取 `/home/deno/functions/certs/mail-ca.pem`。当前代码已在 `_shared/mail-tls-ca.ts` 内置 163/TecSign 证书链兜底；当日志出现 `parsed 2 certificate(s) from bundled 163 mail CA` 时，说明兜底已生效。上线仍建议保留 `MAIL_TLS_CA_CERT_PATH` 配置，便于其他邮箱或后续证书轮换。

2. **仅本地调试（不安全）**：开启本地测试模式  
   - 在 `supabase-selfhost/.env.functions` 增加：

```env
MAIL_LOCAL_TEST_MODE=true
```

> 本地测试模式会强制以明文 IMAP 连接（不走证书校验），只用于开发联调。建议配合端口 `143`；不要用于生产。

#### D4. 重建 functions 容器

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main\scripts
.\sync-functions-to-selfhost.ps1

cd d:\Docker\project\cs-main\supabase-selfhost
docker compose up -d --force-recreate --no-deps functions
```

> 自建 `supabase-selfhost` 不使用 `npx supabase functions deploy`；该命令仅用于 Supabase Cloud。自建环境改函数源码、`_shared` 或 `certs` 后，执行上面的同步脚本并重建 `functions` 即可。

查看日志：

```powershell
docker compose logs functions --tail 100
```

---

### E. 配置 mail-guide-ai 前端（必做）

1. 打开 **`d:\Docker\project\cs-main\supabase-selfhost\.env`**，复制 **`ANON_KEY=`** 的值（整段 JWT）。
2. 在 **`d:\Docker\project\cs-main\mail-guide-ai-main`**：
   - 若没有 `.env`：复制 **`.env.selfhosted.example`** 为 **`.env`**。
   - 若已有 `.env`：只改与 Supabase 相关的三行。
3. 填写：

```env
VITE_SUPABASE_URL=http://localhost:8000
VITE_SUPABASE_PUBLISHABLE_KEY=这里粘贴ANON_KEY
VITE_SUPABASE_PROJECT_ID=self-hosted
```

4. 启动或构建前端：

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main
npm ci
npm run dev
```

或 Docker：

```powershell
docker compose build
docker compose up -d
```

浏览器访问 **`http://localhost:8080`**（或你的端口），尝试注册/登录。

---

### F. Dify 与 Auth 跳转（按你现有架构）

- **Dify**：若邮件分析/草稿依赖 Dify，按 **`docs\startup-commands.md`** 启动 Dify（及 ngrok 等），把 **公网可访问** 的工作流 URL 与 Key 写入 **`.env.functions`**，再重建 **functions**（见 D4）。
- **Auth 跳转**：若登录后重定向异常，检查 **`supabase-selfhost\.env`** 中 **`SITE_URL`** 是否与前端一致（本机常为 `http://localhost:8080`）；必要时配置 **`ADDITIONAL_REDIRECT_URLS`**（逗号分隔多个 URL）。

---

### G. 快速自检命令

```powershell
# Kong 上默认 hello 函数（自建模板自带）
curl.exe -s -o NUL -w "HTTP %{http_code}\n" http://localhost:8000/functions/v1/hello

# 在 Studio SQL 或 psql 中执行（cron 是否已改成本地 Kong）
# SELECT jobname, command FROM cron.job;
```

---

### H. 常见问题

| 现象 | 处理 |
|------|------|
| `db push` 连不上 | 确认 `54323:5432` 已写进 compose 且 `docker compose up -d db`；防火墙放行本机回环。 |
| Kong / Pooler 启动报 `no such file` / `carriage return` | 执行 **`mail-guide-ai-main\scripts\fix-supabase-selfhost-crlf.ps1`** 后重建 kong / supavisor。 |
| 池化端口冲突 5432 | 使用 **`.env`** 里 **`POOLER_PORT_PUBLISHED=54322`**（或见上文「宿主机 5432 已被占用」）。 |
| 前端 CORS / Auth | `SITE_URL`、`SUPABASE_PUBLIC_URL` 与浏览器访问地址一致；检查 Kong 日志。 |
| 添加邮箱报 `UnknownIssuer` | 生产：配置 `MAIL_TLS_CA_CERT_PATH` 指向邮箱 CA 证书链；163/TecSign 已有代码内置兜底，日志应出现 `parsed 2 certificate(s) from bundled 163 mail CA`。本地临时调试才使用 `MAIL_LOCAL_TEST_MODE=true` 并改用 143。修改后都要同步函数并重建 `functions` 容器。 |

## 上线前邮箱专项清单（建议执行）

1. 在 `supabase-selfhost/.env.functions` **关闭**本地测试模式：`MAIL_LOCAL_TEST_MODE=false`（或删除该项）。
2. 配置邮箱 CA 证书：`MAIL_TLS_CA_CERT_PATH=/home/deno/functions/certs/mail-ca.pem`；163/TecSign 另有 `_shared/mail-tls-ca.ts` 内置兜底。
3. 将邮箱配置切回安全模式：IMAP `993` + `use_ssl=true`；SMTP 使用 `465` 或 `587` + TLS；密码使用邮箱客户端授权码。
4. 同步并重建 functions：先运行 `mail-guide-ai-main\scripts\sync-functions-to-selfhost.ps1`，再运行 `docker compose up -d --force-recreate --no-deps functions`。
5. 在工作台执行一次“测试连接 + 立即同步”。
6. 检查 `docker compose logs functions --tail 100`，确认无 `UnknownIssuer`、无 `WorkerRequestCancelled`；163 可关注 `parsed 2 certificate(s) from bundled 163 mail CA`。

## 验证清单

- Studio：`http://localhost:8000` 可登录；Database / Auth 可打开。
- **Cron**：`SELECT jobname, command FROM cron.job;` 中上述 **五条** 任务（含 `run-compensation-tasks-every-30min`、`retry-risk-intercept-hourly-at-45`）的 URL 含自建 Kong 地址，无 Cloud project URL。
- **Functions**：`curl -s -o NUL -w "%{http_code}" http://localhost:8000/functions/v1/hello` 为 **200**（或按日志确认无 502）。
- **前端**：`mail-guide-ai` 使用 `VITE_SUPABASE_URL=http://localhost:8000` 与正确 `ANON_KEY` 后可登录；浏览器无 CORS 报错（必要时检查 `SITE_URL` / `ADDITIONAL_REDIRECT_URLS`）。
- **业务**：在 Dify 与 `.env.functions` 配置齐全后，收信 / 草稿 / 告警链路各试跑一条。

## 与 Supabase Cloud 并存

可先保留 Cloud 项目作备份；自建稳定后再把 DNS 与前端环境切到新网关。数据库与 Storage 需自行做一次迁移或初始全量导入，不在本文展开。

## 参考

- [Self-Hosting Docker](https://supabase.com/docs/guides/self-hosting/docker)
- [Self-Hosted Functions](https://supabase.com/docs/guides/self-hosting/self-hosted-functions)
- 本仓库：`docs/startup-commands.md`（其中 Cloud CLI deploy 命令在自建场景下由「同步 volumes + restart」替代）
