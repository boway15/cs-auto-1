---
name: "mail-guide-ai-dev"
description: "梳理并执行 cs-main 中 mail-guide-ai 相关开发任务：技术栈识别、目录结构定位、前后端实现路径、Dify 与 Supabase（云端/自建）联调、启动部署与故障排查。用户提到 mail-guide-ai、Supabase、Dify、自建部署、Edge Functions、cron、工作流时使用。"
---

# mail-guide-ai（cs-main）开发基线

## 1) 当前项目边界（先判断再动手）

`cs-main` 是多项目工作区，mail-guide-ai 相关实现跨 3 个子目录：

- `mail-guide-ai-main/`：业务前端 + Supabase migrations + Supabase Edge Functions（源码在仓库内）
- `dify/`：Dify 平台本体（独立 Docker 栈，含 Python API + Next.js Web）
- `supabase-selfhost/`：Supabase 官方 Docker 自建模板（已按本仓库做少量适配）

默认运行形态（当前常用）：
- 前端：`mail-guide-ai-main`（本地或 Docker）
- AI 工作流：`dify/docker/docker-compose.cs.yml`
- 数据与函数：**生产默认** `supabase-selfhost`（自建）；开发可选用 Supabase Cloud

## 2) 技术栈速览（以“已落地文件”为准）

### mail-guide-ai-main（业务主仓）

- 前端：React 18 + TypeScript + Vite 5 + react-router-dom 6
- UI：Tailwind CSS + Radix + shadcn/ui
- 状态与请求：@tanstack/react-query v5 + Supabase JS v2
- 表单校验：react-hook-form + zod
- 测试：Vitest + Testing Library + jsdom
- 部署：Nginx（SPA 回退）+ Docker 多阶段构建
- 后端能力：Supabase（Postgres/Auth/Edge Functions/cron）

### dify（平台侧）

- Monorepo：pnpm workspace（根 `packageManager: pnpm@11`）
- Web：Next.js（`dify/web`）
- API：Python 3.12 + Flask + Celery（`dify/api/pyproject.toml`）
- 部署：`dify/docker/docker-compose.cs.yml`（本仓库定制）

### supabase-selfhost（自建可选）

- 关键组件：Kong、Auth、PostgREST、Realtime、Storage、Edge Runtime、Supavisor、Studio、Postgres
- 当前已支持：`functions` 服务通过 `env_file: .env.functions` 注入业务环境变量
- 端口策略：允许通过 `POOLER_PORT_PUBLISHED` 规避宿主机 5432 冲突

## 3) 实现方式（框架层）

### 前端架构（mail-guide-ai-main）

- 入口：`src/main.tsx`
- 组装：`src/App.tsx`（`QueryClientProvider` + `BrowserRouter` + `ProtectedRoute`）
- 权限：`useAuth` 读取 Supabase session + `user_roles`，`ProtectedRoute` 控制 admin 页面
- 页面层：`src/pages/*`（Workbench、Mailboxes、ERP、Templates、Users、Alerts、Logs）
- 基础设施：`src/lib/supabase.ts`、`src/integrations/supabase/*`

### 后端实现（Supabase-first）

- 数据结构：`mail-guide-ai-main/supabase/migrations/*.sql`
- 业务函数：`mail-guide-ai-main/supabase/functions/*/index.ts`（**Supabase Edge Functions / Deno**；自建 Docker 与 Cloud **同一套**源码，仅部署方式不同）
- 典型函数：`sync-mailbox`、`process-email`、`generate-draft`、`send-reply`、`risk-intercept`、`dify-gateway`
- 定时链路：`pg_cron + pg_net` 调度函数（包含自动收信、草稿与补偿类任务）

### Dify 对接方式

- 工作流 DSL 位于 `mail-guide-ai-main/dify-workflows/`
- Supabase Functions 通过 Dify API（常见为 ngrok 暴露地址）触发分析/草稿工作流
- URL/Key 变更时，需同步更新 Cloud secrets 或 `supabase-selfhost/.env.functions`

## 4) 本项目推荐操作顺序（Windows）

1. 启 Dify：`dify/docker/docker-compose.cs.yml`
2. 启前端：`mail-guide-ai-main`（`npm run dev` 或 `docker compose up -d`）
3. Supabase 路径：
   - **自建（优先）**：启动 `supabase-selfhost`，迁移、`vault`/cron URL 指向本栈 Kong，同步 functions
   - 云端（可选）：`npx supabase link` + functions deploy/secrets

参考命令清单：`mail-guide-ai-main/docs/startup-commands.md`

## 5) 常见风险与硬规则

- 严禁提交密钥：`mail-guide-ai-main/.env`、`supabase-selfhost/.env`、`.env.functions`、ngrok token
- 自建迁移后必须执行 vault/cron 修正，避免任务仍打到 `*.supabase.co`
- `supabase/config.toml` 中多个函数 `verify_jwt=false`，生产需配合网关/网络边界
- Windows 若出现 CRLF 脚本启动故障，执行 `mail-guide-ai-main/scripts/fix-supabase-selfhost-crlf.ps1`

## 6) 触发与执行策略（给代理）

当用户提到以下任意主题时，优先应用本技能：
- “技术栈 / 架构 / 目录梳理”
- “mail-guide-ai + Dify + Supabase 联调”
- “自建 Supabase 迁移、函数同步、cron 不生效”
- “本地/生产部署、重启恢复、环境变量排障”

执行时遵循：
1. 先确认目标栈（Cloud 还是 self-hosted）
2. 再确认运行入口（本地 dev 还是 Docker）
3. 最后给最小可执行命令链 + 验证点

