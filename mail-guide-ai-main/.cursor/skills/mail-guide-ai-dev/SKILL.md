---
name: "mail-guide-ai-dev"
description: "mail-guide-ai 跨境电商智能客服邮件系统 — 本地开发、Docker 构建部署、Supabase 配置、技术栈概览和常见问题排查。当你需要开发、调试、构建或部署该项目时使用。"
---

# mail-guide-ai 开发与部署

## 项目概述

**mail-guide-ai**（智能客服工作台）是一套跨境电商智能客服邮件管理系统。客服人员通过 Web 工作台处理入站邮件、查看 AI 草拟回复、将邮件关联到 ERP 订单、通过 SMTP 发送回复、管理回复模板，并对订单执行风控/拦截操作。

界面语言：简体中文。业务领域：跨境电商客服。

---

## 技术栈

| 层 | 技术 |
|---|---|
| **前端框架** | React 18 + TypeScript |
| **构建工具** | Vite 5（SWC 编译） |
| **路由** | react-router-dom v6 |
| **数据请求** | @tanstack/react-query v5 |
| **UI 组件库** | shadcn/ui（Radix UI 基元 + Tailwind CSS） |
| **表单** | react-hook-form + zod |
| **图表** | recharts |
| **日期处理** | date-fns（zhCN locale） |
| **后端服务** | Supabase（**生产默认自建 Docker**；可选用 Cloud） |
| **数据库** | PostgreSQL（随 Supabase 实例） |
| **认证** | Supabase Auth（邮箱/密码） |
| **无服务器** | Supabase Edge Functions（Deno 运行时） |
| **定时任务** | pg_cron + pg_net 扩展 |
| **测试** | Vitest + @testing-library/react |
| **代码检查** | ESLint v9（flat config） |

### 核心依赖

```
@supabase/supabase-js  — Supabase 客户端
@tanstack/react-query  — 服务端状态缓存
react-hook-form + zod  — 表单与验证
lucide-react           — 图标库
date-fns               — 日期处理
```

---

## 本地开发

### 前置条件

- **Node.js 20+**（推荐使用 nvm / fnm）
- **npm**（项目主包管理器，package-lock.json 已提交）
- （可选）**Supabase CLI** — 仅在需要本地运行 Supabase 时安装

### 1. 安装依赖

```bash
cd mail-guide-ai-main
cp .env.example .env   # 填入真实 Supabase 凭据
npm ci                 # 使用 ci 确保与 lockfile 严格一致
```

### 2. 环境变量

创建 `.env` 文件（复制自 `.env.example`）：

```env
VITE_SUPABASE_URL="https://<project-id>.supabase.co"
VITE_SUPABASE_PUBLISHABLE_KEY="<anon-key>"
VITE_SUPABASE_PROJECT_ID="<project-id>"
```

> **⚠️ 安全提示**：`.env` 已加入 `.gitignore`，切勿提交真实凭据到仓库。

### 3. 启动开发服务器

```bash
npm run dev
# 默认在 http://localhost:8080 启动
# IPv6 地址 :: 可能在其他机器上不可访问，可修改 vite.config.ts
```

### 4. 常用命令

```bash
npm run dev           # 启动 Vite 开发服务器
npm run build         # 生产构建
npm run build:dev     # 开发模式构建（不压缩，方便调试）
npm run preview       # 预览生产构建
npm run lint          # ESLint 代码检查
npm run test          # 运行 Vitest 测试（单次）
npm run test:watch    # 监听模式运行测试
npm run release:patch # 版本号 patch 升级 + changelog 生成
```

---

## Docker 构建与部署

项目已配置完整的多阶段 Docker 构建。

### 构建

```bash
# 方式一：docker compose（推荐）
docker compose build

# 方式二：docker build（需手动传入构建参数）
docker build \
  --build-arg VITE_SUPABASE_URL="https://xxx.supabase.co" \
  --build-arg VITE_SUPABASE_PUBLISHABLE_KEY="eyJ..." \
  --build-arg VITE_SUPABASE_PROJECT_ID="xxx" \
  -t mail-guide-ai:latest .
```

### 运行

```bash
# docker compose（端口 8080）
docker compose up -d

# 纯 docker
docker run -d -p 8080:80 --name mail-guide-ai mail-guide-ai:latest
```

访问：**http://localhost:8080**

### 构建流程说明

Dockerfile 分为两个阶段：

1. **Stage 1（builder）**：基于 `node:20-alpine`，执行 `npm ci` → `npm run build`（Vite 构建时会将 `VITE_*` 环境变量内联到 JS bundle 中）
2. **Stage 2（production）**：基于 `nginx:alpine`，复制构建产物到 `/usr/share/nginx/html`，使用自定义 `nginx.conf` 处理 SPA 路由

### Nginx 配置要点

- Gzip 压缩：JS/CSS/JSON/SVG
- 静态资源（含 hash）：1 年缓存 `Cache-Control: public, immutable`
- SPA 回退：所有非文件请求返回 `index.html`
- 安全头：`X-Frame-Options`, `X-Content-Type-Options`, `X-XSS-Protection`

### 健康检查

```bash
# 容器内健康检查
docker exec mail-guide-ai wget -qO- http://localhost:80/

# 外部
curl -I http://localhost:8080/
```

---

## 项目结构

```
mail-guide-ai-main/
├── .env                      # 环境变量（有真实凭据，勿提交）
├── .env.example              # 环境变量模板
├── Dockerfile                # 多阶段构建
├── docker-compose.yml        # docker compose 编排
├── nginx.conf                # Nginx SPA 配置
├── package.json              # 依赖与脚本
├── vitest.config.ts          # 测试配置
├── vite.config.ts            # Vite 构建配置
├── tailwind.config.ts        # Tailwind + 自定义主题
├── tsconfig.json             # TypeScript 配置
├── supabase/
│   └── migrations/           # 17 个 SQL 迁移文件
├── src/
│   ├── main.tsx              # 入口
│   ├── App.tsx               # 根组件（路由 + QueryClient）
│   ├── lib/
│   │   ├── supabase.ts       # Supabase 客户端单例
│   │   └── utils.ts          # cn() 工具函数
│   ├── hooks/
│   │   └── useAuth.ts        # 鉴权 hook
│   ├── components/
│   │   ├── AppLayout.tsx     # 侧边栏布局
│   │   ├── ProtectedRoute.tsx# 鉴权守卫
│   │   └── ui/               # ~50 个 shadcn/ui 组件
│   └── pages/
│       ├── Auth.tsx          # 登录/注册
│       ├── Workbench.tsx     # 主工作台（邮件队列+ AI 草稿）
│       ├── Mailboxes.tsx     # 邮箱配置
│       ├── Templates.tsx     # 回复模板
│       ├── Users.tsx         # 用户管理
│       ├── SendLogs.tsx      # 发送日志
│       └── RiskLogs.tsx      # 风控日志
```

---

## 路由与权限

| 路径 | 页面 | 权限 |
|---|---|---|
| `/auth` | 登录/注册 | 未认证用户 |
| `/` | 工作台 | 所有已认证用户 |
| `/send-logs` | 发送日志 | 所有已认证用户 |
| `/risk-logs` | 风控日志 | 所有已认证用户 |
| `/alerts` | 运营告警 | 所有已认证用户 |
| `/mailboxes` | 邮箱配置 | 仅 admin |
| `/templates` | 回复模板 | 仅 admin |
| `/users` | 用户管理 | 仅 admin |

角色：`admin`（管理员）、`leader`（组长）、`agent`（客服）。
首次注册的用户自动成为 admin，后续注册自动为 agent。

---

## Supabase Edge Functions

项目前端调用以下 Supabase Edge Functions（源码不在本仓库中，通过 Supabase CLI / Dashboard 单独部署）：

| Function | 用途 |
|---|---|
| `generate-draft` | 根据邮件内容生成 AI 回复草稿 |
| `schedule-draft-generation` | 自动草稿调度（0-4h Dify，4-24h 本地） |
| `close-email` | 人工结案（已处理） |
| `sync-mailbox` | 通过 IMAP/POP3 同步收件箱 |
| `send-reply` | 通过 SMTP 发送回复邮件 |
| `test-mailbox` | 测试 IMAP 连接 |
| `risk-intercept` | 订单风控拦截/放行 |

前端调用方式：`supabase.functions.invoke('function-name', { body })`

---

## 定时任务

通过 PostgreSQL `pg_cron` + `pg_net` 扩展实现（收信与草稿错峰，减轻同一时刻负载）：
- **`auto-sync-mailbox-every-5min`**（job 名历史遗留）：每 4 分钟、自整点 0 分起调用 `sync-mailbox` 自动收信（`*/4 * * * *`）
- **`auto-draft-every-30min`**（job 名历史遗留）：每 4 分钟、自第 2 分起调用 `schedule-draft-generation`（`2-59/4 * * * *`，与收信错开 2 分钟）
- **`compensating-alerts-every-30min`**：有单未关联内部预警，每小时第 15 分调用 `schedule-compensating-alerts`（`15 * * * *`）
- **`run-compensation-tasks-every-30min`**（job 名历史遗留）：订单补偿扫描，**每小时第 14 分**（`14 * * * *`），与 `next_run_at` 推迟 **1 小时** 一致

---

## 常见问题排查

### Docker 构建失败

1. **构建参数未传入** → 确保 `.env` 文件存在且 `docker compose` 能读取到变量
2. **npm ci 失败** → 检查 Node.js 版本是否为 20+，网络是否可达 npm registry
3. **Vite 构建 OOM** → 增加 Docker 内存限制：`docker compose build --memory=4g`

### 本地开发时 Supabase 连接失败

- 确认 `.env` 中三个变量与 Supabase Dashboard 中的值一致
- 检查浏览器控制台是否有 CORS 错误（应在 Supabase Dashboard → API Settings 中配置允许的域名）
- `Publishable Key` 是 **anon key**（公开可暴露的），不是 `service_role key`

### SPA 路由刷新 404

- 确认 `nginx.conf` 中 `try_files $uri $uri/ /index.html;` 已正确配置
- 清除浏览器缓存后重试

### TypeScript 类型问题

项目 `tsconfig.json` 中 `strict: false`，部分组件使用 `type Email = any`。如需增强类型安全：
1. 在 `src/types/` 下创建类型定义文件
2. 逐步启用 strict 模式

---

## 版本发布

```bash
npm run release:patch   # 0.0.x → 0.0.x+1
npm run release:minor   # 0.x.0 → 0.x+1.0
npm run release:major   # x.0.0 → x+1.0.0
```

自动生成 CHANGELOG（基于 conventional commits），创建 git tag 并提交。

---

## 补充说明

- 项目由 Lovable（AI 网页应用构建器）生成，已有完整的 Supabase 迁移（17 个 SQL 文件）
- Edge Functions 源码不在本仓库，需通过 Supabase CLI 单独管理
- bun lockfile（`bun.lock`/`bun.lockb`）存在于仓库但非主要包管理器，建议统一使用 npm

