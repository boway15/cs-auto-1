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

```text
1. Dify（d:\Docker\project\cs-main\dify\docker）
2. ngrok（已并入 Dify compose，一起启动）
3. mail-guide-ai 前端（d:\Docker\project\cs-main\mail-guide-ai-main）
4. Supabase 云端（无需本地启动，仅需 CLI 部署/配置）
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
npx supabase functions deploy close-email
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
```

---

## 五、验证清单

- Dify：打开 `http://localhost:8090` 能登录
- 前端：打开 `http://localhost:8080` 能看到登录页
- ngrok：`http://localhost:4040` 可看到 tunnel
- Supabase：Dashboard 中 Edge Functions 状态正常
- 定时任务：Supabase Database Cron 中 `auto-sync-mailbox-every-5min` 启用
- 定时任务：Supabase Database Cron 中 `auto-draft-every-30min` 启用

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
