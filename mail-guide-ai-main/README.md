# mail-guide-ai（当前运行现状）

跨境电商客服邮件工作台，核心链路为：收信同步 -> AI 分析 -> 订单关联/推荐 -> 草稿生成 -> 人工发送 -> 拦截记录。

## 当前已落地架构

- 前端：`React + Vite`（默认 `http://localhost:8080`）
- 数据与后端：`Supabase` — **生产默认自建 Docker**（`supabase-selfhost`）；业务逻辑在 **Supabase Edge Functions（Deno）**，源码在 `supabase/functions/`，自建栈通过 `scripts/sync-functions-to-selfhost.ps1` 同步
- AI 工作流：`Dify`（`dify/docker/docker-compose.cs.yml`，默认 `http://localhost:8090`）
- 定时任务：`pg_cron + pg_net` 调用 `sync-mailbox`、`schedule-draft-generation` 等函数（自建时 URL 须指向本栈 Kong，勿写死 `*.supabase.co`）

> 长期架构备选见 `docs/risk-and-plan.md`（规划稿）。

## 目录速览

- `src/`：前端页面与组件
- `supabase/functions/`：Edge Functions（IMAP/SMTP/AI/风控/调度）
- `supabase/migrations/`：数据库迁移与 RLS
- `dify-workflows/`：Dify DSL 与对接
- `docs/startup-commands.md`：命令速查
- `docs/self-hosted-supabase.md`：自建 Supabase 全流程与排障
- `docs/customer-service-automation-spec.md`：客服自动化与分流口径；**§6.4 自动风控拦截**（与仓库根目录 `docs/production-go-live.md` **§5.5** 对照）

## 快速开始

### 1) 前端

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

### 2) Dify

```powershell
cd d:\Docker\project\cs-main\dify\docker
docker compose -f docker-compose.cs.yml up -d
```

### 3) Supabase（Self-hosted，生产推荐）

按 `docs/self-hosted-supabase.md` 执行（含 Docker 初始化、迁移、vault/cron 修正、functions 同步）。

### 4) Supabase（Cloud，仅历史/特殊场景）

若团队仍保留云端项目，CLI 的 `login` / `link` / `functions deploy` 见 `docs/startup-commands.md`「4.4」。

## 邮箱连接现状（重要）

当前代码已支持两种模式：

1. 生产推荐（安全）
   - IMAP/SMTP 走 TLS
   - 若报 `UnknownIssuer`，通过 `.env.functions` 配置：
     - `MAIL_TLS_CA_CERT_PATH`
     - 或 `MAIL_TLS_CA_CERT_PEM`
   - 自建环境中，163/TecSign 证书链已在 `_shared/mail-tls-ca.ts` 内置兜底；日志出现 `parsed 2 certificate(s) from bundled 163 mail CA` 表示已生效。

2. 本地测试模式（仅调试，不安全）
   - `.env.functions` 设置 `MAIL_LOCAL_TEST_MODE=true`
   - 会强制明文连接（建议 IMAP 143，SMTP 25/587）
   - 不要用于生产

自建 `supabase-selfhost` 修改函数、`_shared` 或 `certs` 后，执行 `scripts/sync-functions-to-selfhost.ps1` 并重建 `functions` 容器；不需要 `npx supabase functions deploy`（该命令仅用于 Supabase Cloud）。

以上说明与步骤见：

- `docs/self-hosted-supabase.md`（上线前清单已补充）
- `docs/startup-commands.md`（`UnknownIssuer` 快速处理命令）

## 关键提醒

- 严禁提交真实密钥（`.env`、`.env.functions`、ngrok token、各类 API Key）
- 修改 `supabase-selfhost/.env.functions` 后，需重建 functions：
  - `docker compose up -d --force-recreate --no-deps functions`
- `supabase/config.toml` 里部分函数 `verify_jwt = false`，生产必须配合网关与网络边界控制
