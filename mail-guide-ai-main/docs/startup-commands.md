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

**仅本地开发且后端仍用 Supabase Cloud（历史路径，不推荐新环境）：** 与上类似，但数据库与函数发布走 Supabase Cloud CLI；细节见下文「4.4」。

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

> ngrok 免费版 URL 可能变化。自建栈请在 `supabase-selfhost/.env.functions` 更新 `DIFY_ANALYZE_URL` / `DIFY_DRAFT_URL` 后重建 `functions`；云端项目则更新 Functions secrets。

### 4.4 Supabase 云端（CLI，可选 / 历史）

仅在仍维护 **Supabase Cloud** 上的项目时使用；**新环境请优先「4.5」自建栈。**

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main
npx supabase login
npx supabase link --project-ref <your-project-ref>
```

随后用 `npx supabase functions deploy <函数名>` 发布 `supabase/functions/` 中的实现，并用 `npx supabase functions secrets set KEY=value` 配置 `DIFY_*`、`DIFY_GATEWAY_API_KEY` 及 ERP 等密钥。函数清单以 `supabase/config.toml` 与仓库内 `supabase/functions/*` 为准；勿在仓库或聊天中粘贴真实密钥。

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
# 生产推荐：配置邮箱 CA 证书链（PEM）后同步并重建 functions
# 1) 将证书放到：
#    d:\Docker\project\cs-main\mail-guide-ai-main\supabase\functions\certs\mail-ca.pem
#    同步脚本会复制到 supabase-selfhost\volumes\functions\certs\mail-ca.pem
# 2) 在 supabase-selfhost\.env.functions 添加：
#    MAIL_TLS_CA_CERT_PATH=/home/deno/functions/certs/mail-ca.pem
cd d:\Docker\project\cs-main\mail-guide-ai-main\scripts
.\sync-functions-to-selfhost.ps1

cd d:\Docker\project\cs-main\supabase-selfhost
docker compose up -d --force-recreate --no-deps functions
```

> 自建 `supabase-selfhost` 不需要 `npx supabase functions deploy`；那是 Supabase Cloud 的发布命令。163/TecSign 证书链已在 `_shared/mail-tls-ca.ts` 内置兜底，日志出现 `parsed 2 certificate(s) from bundled 163 mail CA` 表示兜底生效。

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

### Supabase Cloud（仅历史项目）

Dashboard 中 Functions / Cron 与团队云端迁移一致即可；新环境不做默认检查项。

### 自建 Supabase（Docker）

- `docker compose ps`（在 `supabase-selfhost`）主要服务 healthy
- 已在 **`scripts/selfhosted/Apply-VaultAndCron.ps1`** 执行后，Postgres 中 **5 条** cron 齐全（与 [`docs/self-hosted-supabase.md`](./self-hosted-supabase.md)「四步续」表格一致），含 **`run-compensation-tasks-every-30min`**（每 30 分钟订单补偿，与 `order_compensation_tasks.next_run_at` 步长一致）及 **`retry-risk-intercept-hourly-at-45`**（每小时第 45 分自动风控拦截补偿）。
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
