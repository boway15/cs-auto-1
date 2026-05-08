# mail-guide-ai（当前实现基线）

跨境电商客服邮件工作台，核心链路为：收信同步 -> AI 分析 -> 订单关联/推荐 -> 草稿生成 -> 人工发送或自动模板回复 -> 风控拦截记录。

## 当前技术架构（重要）

当前仓库**已落地**架构：

- 前端：React + Vite（Docker/Nginx，默认 `http://localhost:8080`）
- 后端能力：Supabase Cloud（PostgreSQL + Auth + Edge Functions）
- AI 工作流：Dify（本机 Docker），由 Supabase Edge Functions 通过公网地址调用
- 定时：pg_cron 触发 `sync-mailbox`

> `docs/architecture-design.md` 是“未来自托管 Node.js 架构方案”，不是当前运行时架构。

## 目录说明

- `src/`：前端页面与组件
- `supabase/functions/`：Edge Functions（IMAP、SMTP、AI、风控等）
- `supabase/migrations/`：数据库迁移与 RLS 策略
- `dify-workflows/`：Dify DSL 与对接说明
- `docs/startup-commands.md`：本机启动与部署命令（已对齐 `cs-main` 路径）

## 快速开始

### 1) 前端（本项目）

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main
copy .env.example .env
npm ci
npm run dev
```

或 Docker：

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main
docker compose build
docker compose up -d
```

### 2) Dify（独立栈）

```powershell
cd d:\Docker\project\cs-main\dify\docker
docker compose -f docker-compose.cs.yml up -d
```

默认入口：`http://localhost:8090`

### 3) Supabase（云端）

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main
npx supabase login
npx supabase link --project-ref elchuqvftkhszbkwgfjp
```

按需部署函数与 secrets（见 `docs/startup-commands.md` 与 `dify-workflows/README.md`）。

## 关键提醒

- 不要把真实密钥提交到仓库（`.env`、ngrok token、各类 API key）
- `supabase/config.toml` 中部分函数 `verify_jwt = false`，必须配合入口密钥与网络边界使用
- 若 Dify 地址变化（如 ngrok 变更），需要同步更新 Supabase Functions Secrets
