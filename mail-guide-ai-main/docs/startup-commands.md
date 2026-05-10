# 项目启动命令速查（按当前仓库）

## 0. 电脑重启后先做这一步（重新允许项目）

在 Windows 重启后，优先确认 Docker Desktop 已正常运行，并对本项目路径重新授权（若系统弹窗询问）：

- `d:\Docker\project\cs-main\dify`
- `d:\Docker\project\cs-main\mail-guide-ai-main`

建议先执行：

```powershell
docker version
docker info
```

若报错（例如 Docker daemon 未启动），先打开 Docker Desktop，待状态为 Running 后再继续。

## 一、环境要求

```powershell
node --version        # v20+
npm --version         # 10+
docker --version      # 需安装 Docker Desktop
```

---

## 二、启动顺序

**生产 / 团队默认（自建 Supabase）：**

```text
1. supabase-selfhost（d:\Docker\project\cs-main\supabase-selfhost）— 见 docs/self-hosted-supabase.md
2. Dify（d:\Docker\project\cs-main\dify\docker）
3. mail-guide-ai 前端（d:\Docker\project\cs-main\mail-guide-ai-main）
```

**仅本地开发且数据库仍用 Supabase Cloud 时：**

```text
1. Dify（d:\Docker\project\cs-main\dify\docker）
2. ngrok（已并入 Dify compose，一起启动）
3. mail-guide-ai 前端
4. Supabase Cloud（无需本地起库，仅需 CLI 部署/配置）
```

---

## 三、快速启动（推荐）

### 终端 A：启动 Dify

```powershell
cd d:\Docker\project\cs-main\dify\docker
docker compose -f docker-compose.cs.yml up -d
docker compose -f docker-compose.cs.yml ps
```

访问：`http://localhost:8090`

> `dify-ngrok` 已包含在 `docker-compose.cs.yml`，执行上述命令会一并启动。

### 终端 B：启动前端

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main
docker compose build
docker compose up -d
```

访问：`http://localhost:8080`

---

## 四、分服务命令

### 4.1 前端（mail-guide-ai）

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main

# Docker 方式
docker compose build
docker compose up -d

# 本地开发方式
npm ci
npm run dev
```

### 4.2 Dify（cs-main 配置）

```powershell
cd d:\Docker\project\cs-main\dify\docker

docker compose -f docker-compose.cs.yml up -d
docker compose -f docker-compose.cs.yml ps -a
docker compose -f docker-compose.cs.yml logs dify-api --tail 50
docker compose -f docker-compose.cs.yml logs dify-nginx --tail 50
docker compose -f docker-compose.cs.yml logs dify-worker --tail 50
```

### 4.3 ngrok

当前项目 ngrok 已容器化，配置文件为：

- `d:\Docker\project\cs-main\dify\docker\ngrok\ngrok.yml`

tunnel 通过容器网络转发到 `dify-nginx:80`，对外暴露 API。

```powershell
cd d:\Docker\project\cs-main\dify\docker
docker compose -f docker-compose.cs.yml up -d dify-ngrok

# 查看隧道
curl.exe http://localhost:4040/api/tunnels
```

`ngrok/ngrok.yml` 通常不需要改。只有以下情况才需要重配：

1. ngrok token 失效/丢失（需更新 `ngrok/ngrok.yml` 的 `authtoken`）
2. Dify 网关容器/端口发生变化（需同步改 `ngrok.yml` 的 `addr`）
3. 改用了不同 tunnel 名称（需同步改启动命令中的 `dify-api`）

> ngrok 免费版 URL 可能变化。若 URL 变化，需要更新 Supabase Functions Secrets 里的 `DIFY_ANALYZE_URL` / `DIFY_DRAFT_URL`。

### 4.4 Supabase 云端（CLI）

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main

npx supabase login
npx supabase link --project-ref elchuqvftkhszbkwgfjp

# 常用函数部署
npx supabase functions deploy sync-mailbox --no-verify-jwt
npx supabase functions deploy process-email --no-verify-jwt
npx supabase functions deploy generate-draft
npx supabase functions deploy schedule-draft-generation --no-verify-jwt
npx supabase functions deploy schedule-compensating-alerts --no-verify-jwt
npx supabase functions deploy run-compensation-tasks --no-verify-jwt
# close-email 为遗留函数，产品主流程以「已回复」为主，可选部署
# npx supabase functions deploy close-email
npx supabase functions deploy send-reply
npx supabase functions deploy risk-intercept
npx supabase functions deploy dify-gateway --no-verify-jwt
npx supabase functions deploy get-email-context --no-verify-jwt
npx supabase functions deploy get-order-by-email --no-verify-jwt
npx supabase functions deploy test-mailbox --no-verify-jwt

# Dify 相关 secrets
npx supabase functions secrets set DIFY_GATEWAY_API_KEY="replace_with_strong_key"
npx supabase functions secrets set DIFY_ANALYZE_URL="https://xxxx.ngrok-free.app/v1/workflows/run"
npx supabase functions secrets set DIFY_ANALYZE_KEY="app-xxxxx1"
npx supabase functions secrets set DIFY_DRAFT_URL="https://xxxx.ngrok-free.app/v1/workflows/run"
npx supabase functions secrets set DIFY_DRAFT_KEY="app-xxxxx2"

# ERP（Edge 单出口；勿把密码写入仓库）
# npx supabase functions secrets set ERP_TOKEN_URL="https://loginserver.bestwo.net:9443/connect/token"
# npx supabase functions secrets set ERP_OMS_BASE="https://omsapi.bestwo.net:9443"
# npx supabase functions secrets set ERP_GATEWAY_BASE="https://gatewayjava.bestwo.net:9443"
# npx supabase functions secrets set ERP_USERNAME="..."
# npx supabase functions secrets set ERP_PASSWORD="..."
# npx supabase functions secrets set ERP_CLIENT_ID="ERP"
# 测试环境 IdP 使用 pw 字段时：ERP_TOKEN_PASSWORD_FIELD=pw
```

### 4.5 Supabase 自建 Docker（`supabase-selfhost`）

完整说明见 **`mail-guide-ai-main/docs/self-hosted-supabase.md`**。**从零搭栈、逐项勾选与排错**请优先阅读该文档中的 **「本地从零到可用：总清单」**；下面为最小命令链速查。

```powershell
# 1) 临时给 db 暴露 54323:5432（写在 supabase-selfhost/docker-compose.yml 的 db 服务下），然后：
cd d:\Docker\project\cs-main\mail-guide-ai-main
$env:PGSSLMODE = "disable"
npx supabase db push --db-url "postgresql://postgres:<POSTGRES_PASSWORD>@127.0.0.1:54323/postgres"
# 推完后删除临时 ports 并 docker compose up -d

# 2) Vault + pg_cron 指向栈内 Kong
cd d:\Docker\project\cs-main\mail-guide-ai-main\scripts\selfhosted
.\Apply-VaultAndCron.ps1

# 3) 同步 Edge Functions + env_file
cd d:\Docker\project\cs-main\mail-guide-ai-main\scripts
.\sync-functions-to-selfhost.ps1
cd d:\Docker\project\cs-main\mail-guide-ai-main\scripts\selfhosted
.\Ensure-FunctionsEnvFileInCompose.ps1
# 复制 docs/self-hosted-env-functions.example -> supabase-selfhost/.env.functions 并填写
cd d:\Docker\project\cs-main\supabase-selfhost
docker compose up -d --force-recreate --no-deps functions

# 4) 前端：复制 mail-guide-ai-main/.env.selfhosted.example -> .env，填 ANON_KEY
```

#### 4.5.1 邮箱 `UnknownIssuer` 快速处理

```powershell
# 生产推荐：配置邮箱 CA 证书链（PEM）后重建 functions
# 1) 将证书放到：d:\Docker\project\cs-main\supabase-selfhost\volumes\functions\certs\mail-ca.pem
# 2) 在 supabase-selfhost\.env.functions 添加：
#    MAIL_TLS_CA_CERT_PATH=/home/deno/functions/certs/mail-ca.pem
cd d:\Docker\project\cs-main\supabase-selfhost
docker compose up -d --force-recreate --no-deps functions
```

```powershell
# 仅本地调试（不安全）：开启本地测试模式并重建 functions
# 在 supabase-selfhost\.env.functions 添加：
# MAIL_LOCAL_TEST_MODE=true
cd d:\Docker\project\cs-main\supabase-selfhost
docker compose up -d --force-recreate --no-deps functions
# 提示：本地测试模式建议使用 IMAP 143（明文）
```

---

## 五、验证清单

### 通用

- Dify：打开 `http://localhost:8090` 能登录
- 前端：打开 `http://localhost:8080` 能看到登录页
- ngrok（若使用）：`http://localhost:4040` 可看到 tunnel

### Supabase Cloud（CLI 部署时）

- Dashboard 中 Edge Functions 列表正常
- Database → Cron：`auto-sync-mailbox-every-5min`、`auto-draft-every-30min`、`compensating-alerts-every-30min` 等与迁移一致（Cloud 项目是否含 `run-compensation-tasks` 以实际迁移为准；自建见下）

### 自建 Supabase（Docker）

- `docker compose ps`（在 `supabase-selfhost`）主要服务 healthy
- 已在 **`scripts/selfhosted/Apply-VaultAndCron.ps1`** 执行后，Postgres 中 **4 条** cron 齐全（与 [`docs/self-hosted-supabase.md`](./self-hosted-supabase.md)「四步续」表格一致），含 **`run-compensation-tasks-every-30min`**（每 30 分钟订单补偿，与 `order_compensation_tasks.next_run_at` 步长一致）
- 校验 SQL（勿把输出中的密钥贴到公共环境）：

```sql
SELECT jobname, schedule FROM cron.job
WHERE jobname IN (
  'auto-sync-mailbox-every-5min',
  'auto-draft-every-30min',
  'compensating-alerts-every-30min',
  'run-compensation-tasks-every-30min'
)
ORDER BY jobname;
-- 预期 4 行；command 中不应含 *.supabase.co
SELECT name FROM vault.secrets WHERE name = 'service_role_key';
```

---

## 六、重启后一键恢复（可直接复制）

```powershell
# 1) Dify
cd d:\Docker\project\cs-main\dify\docker
docker compose -f docker-compose.cs.yml up -d

# 2) 前端
cd d:\Docker\project\cs-main\mail-guide-ai-main
docker compose up -d
```
