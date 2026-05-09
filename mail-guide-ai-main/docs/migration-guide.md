# mail-guide-ai 新电脑迁移教程（当前仓库基线）

> **生产发布默认自建 Supabase（Docker）**，见 `docs/self-hosted-supabase.md`。  
> 下文同时保留「仅迁移开发机 + 连现有云端项目」的简化路径；若团队已全面自建，请以自建文档为准。  
> Node 后端替代方案见 `docs/risk-and-plan.md`（规划稿，非当前主路径）。

---

## 1. 架构与迁移范围

**推荐（生产）链路：**

```text
前端(8080) -> 自建 Supabase(Kong: Auth/DB + Edge Functions 运行时)
                         -> ngrok/内网 -> Dify(8090)
```
（自建与 Cloud **同为** Edge Functions；仅网关 URL 与函数发布流程不同。）

**开发机仅重装工具、数据仍在云端时：**

```text
前端(8080) -> Supabase Cloud(Auth/DB/Functions)
                         -> ngrok -> 本机 Dify(8090)
```

需要迁移（新机器上的代码与容器）：

- `d:\Docker\project\cs-main\mail-guide-ai-main`
- `d:\Docker\project\cs-main\dify\docker`
- 自建时另需：`d:\Docker\project\cs-main\supabase-selfhost`（按 `docs/self-hosted-supabase.md`）

不需要迁移（除非你做全量换机）：

- 云端已有数据与 Auth 用户（仍用 Cloud 时）
- 自建库内数据（仍用自建时，随 Postgres 卷备份迁移）

---

## 2. 前置准备

```powershell
node --version
npm --version
docker --version
docker compose version
npx supabase --version
ngrok --version
```

---

## 3. 启动 Dify（当前仓库）

```powershell
cd d:\Docker\project\cs-main\dify\docker
docker compose -f docker-compose.cs.yml up -d
docker compose -f docker-compose.cs.yml ps
```

访问：`http://localhost:8090`

---

## 4. 导入并发布 Dify 工作流

在 Dify 后台导入：

- `d:\Docker\project\cs-main\mail-guide-ai-main\dify-workflows\email-analysis.yml`
- `d:\Docker\project\cs-main\mail-guide-ai-main\dify-workflows\draft-generation.yml`

然后分别发布并创建 API Key。

---

## 5. 启动 ngrok

```powershell
ngrok config add-authtoken <your-token>

cd d:\Docker\project\cs-main\mail-guide-ai-main
ngrok start --config dify-workflows/ngrok.yml dify-api
```

> `dify-workflows/ngrok.yml` 已按当前仓库映射 `addr: 8090`。  
> ngrok URL 变化后要同步更新 Supabase secrets。

---

## 6. 前端与 Supabase 配置

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main
copy .env.example .env
```

填写 `.env`：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_SUPABASE_PROJECT_ID`

登录并关联项目：

```powershell
npx supabase login
npx supabase link --project-ref elchuqvftkhszbkwgfjp
```

---

## 7. 部署核心 Edge Functions

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main

npx supabase functions deploy sync-mailbox --no-verify-jwt
npx supabase functions deploy process-email --no-verify-jwt
npx supabase functions deploy generate-draft
npx supabase functions deploy send-reply
npx supabase functions deploy risk-intercept
npx supabase functions deploy dify-gateway --no-verify-jwt
npx supabase functions deploy get-email-context --no-verify-jwt
npx supabase functions deploy get-order-by-email --no-verify-jwt
npx supabase functions deploy test-mailbox --no-verify-jwt
```

---

## 8. 推送数据库迁移

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main
npx supabase db push
```

当前仓库迁移文件数为 **17**（`supabase/migrations/*.sql`）。

---

## 9. 配置 Functions Secrets

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main

npx supabase functions secrets set DIFY_GATEWAY_API_KEY="replace_with_strong_key"
npx supabase functions secrets set DIFY_ANALYZE_URL="https://xxxx.ngrok-free.app/v1/workflows/run"
npx supabase functions secrets set DIFY_ANALYZE_KEY="app-xxxxx1"
npx supabase functions secrets set DIFY_DRAFT_URL="https://xxxx.ngrok-free.app/v1/workflows/run"
npx supabase functions secrets set DIFY_DRAFT_KEY="app-xxxxx2"
```

可选（Dify 草稿回退）：

```powershell
npx supabase functions secrets set LOVABLE_API_KEY="your_lovable_key"
```

---

## 10. 验证

- Dify：`http://localhost:8090` 可访问
- 前端：`http://localhost:8080` 可登录
- ngrok：`http://localhost:4040/api/tunnels` 可见 `dify-api`
- Supabase Dashboard 中 Edge Functions 状态正常
- `auto-sync-mailbox-every-5min` cron 启用

---

## 11. 常见问题

- Dify 打不开：确认使用的是 `docker-compose.cs.yml` 且端口是 `8090`
- Dify 调用超时：确认 ngrok 在线，且 URL 与 secrets 一致
- 草稿失败：确认 `DIFY_DRAFT_*` 或 `LOVABLE_API_KEY` 至少配置一套
- `dify-gateway` 401：确认请求头带 `x-api-key` 且值等于 `DIFY_GATEWAY_API_KEY`
