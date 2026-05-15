# 运维手册：mail-guide-ai + 自建 Supabase（CentOS / Linux）

**读者**：生产/验收环境运维  
**路径**：`REPO_ROOT` = 仓库在服务器上的绝对路径（示例 `/opt/cs-main`）。命令均在 **Bash** 下执行。  
**本期范围**：**自建 Supabase** + **mail-guide-ai 前端**。**不含 Dify 容器安装**（现网 Dify 的 URL/Key 写入 `.env.functions` 即可）。

**首次上线推荐顺序**：**第二节（Supabase）→ 第四节（脚本与验收）→ 第三节（前端）**。前端依赖 Kong 地址与 `ANON_KEY`，库表与 Functions 须先就绪。

---

## 一、项目说明与中间件架构

### 1.1 项目做什么

**mail-guide-ai** 是跨境电商客服邮件工作台，主要链路：

```text
收信同步 → AI 分析（Dify）→ 订单关联 → 草稿生成 → 人工发送 → 风控/补偿
```

运维在本手册中负责：**把数据层（Postgres）、业务 API（Edge Functions）、管理台（Studio）、工作台前端** 在 CentOS 上以 Docker 稳定跑起来。业务规则与 SQL 由研发维护在仓库 `mail-guide-ai-main/supabase/` 下，运维按本文执行发布即可。

### 1.2 仓库里与运维相关的目录

| 路径 | 作用 |
|------|------|
| `mail-guide-ai-main/` | 前端源码；`supabase/migrations`（表结构）；`supabase/functions`（Edge Functions 源码） |
| `supabase-selfhost/` | 官方 Supabase Docker 自建栈（compose、`.env`、数据卷、`volumes/functions`） |
| `mail-guide-ai-main/scripts/linux/` | 运维脚本（生成栈、同步函数、修正 cron 等） |

### 1.3 整体架构（运维视角）

```text
┌─────────────────────────────────────────────────────────────────┐
│  用户浏览器                                                       │
│    ├─ mail-guide-ai 工作台  (mail-guide-ai 容器, 默认 :8080)      │
│    └─ Supabase Studio       (经 Kong, 默认 :8000)                │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTPS/HTTP
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  supabase-selfhost (Docker Compose)                              │
│                                                                  │
│  kong ──────► auth / rest / realtime / storage / functions       │
│    │                              │                              │
│    │                              └── Edge Functions (Deno)      │
│    │                                   收信/发信/ERP/Dify 网关等    │
│    ▼                                                             │
│  db (PostgreSQL)  ◄── migrations 建表 + RLS                      │
│       ▲                                                          │
│       └── pg_cron + pg_net ──定时──► Kong /functions/v1/...      │
└────────────────────────────┬────────────────────────────────────┘
                             │ 出站（防火墙须放行）
                             ▼
              外部：邮箱 IMAP/SMTP、ERP、Dify（现网，非本手册部署）
```

**说明**：没有单独的 Java/Node 业务后端进程；**业务 API 全部在 Edge Functions 容器**（`functions`）中，经 **Kong** 对外提供 `/functions/v1/<函数名>`。

### 1.4 `supabase-selfhost` 栈内中间件

| 组件 | 作用 |
|------|------|
| **kong** | API 网关；REST、Auth、Storage、Realtime、**Functions**、Studio 均经此入口 |
| **db** | PostgreSQL，存放业务表与 `cron.job` |
| **auth** | 用户注册/登录/JWT（工作台账号） |
| **rest** | PostgREST，供前端读写表 |
| **realtime** | 实时订阅 |
| **storage** | 对象存储 |
| **functions** | Edge Functions 运行时（加载 `volumes/functions`） |
| **studio** | 数据库/Auth 管理界面 |
| **supavisor** | 连接池；宿主机 **5432** 冲突时改 `POOLER_PORT_PUBLISHED` |
| **meta** | Studio 用的库元数据 |
| **imgproxy / vector / analytics** | 按官方模板启用（图片、向量、日志等） |

### 1.5 mail-guide-ai 前端容器

| 项 | 说明 |
|----|------|
| 构建 | Node 编译 Vite 静态资源 → Nginx 托管 |
| 默认端口 | **`8080:80`**（见 `mail-guide-ai-main/docker-compose.yml`） |
| 配置 | `mail-guide-ai-main/.env` 中 `VITE_SUPABASE_*` 指向 Kong 与 `ANON_KEY` |

### 1.6 自建与 Supabase Cloud 的命令区别

| 要做的事 | 自建 Docker（本手册） | 不要用 |
|----------|----------------------|--------|
| 数据库表 / 迁移 | `npx supabase db push --db-url ...` | — |
| 发布 Edge Functions | `sync-functions-to-selfhost.sh` + 重建 `functions` | `npx supabase functions deploy` |

---

## 二、创建并部署自建 Supabase

### 2.0 每次操作前

```bash
export REPO_ROOT=/opt/cs-main          # 改成实际路径

chmod +x "$REPO_ROOT/mail-guide-ai-main/scripts/linux/"*.sh \
         "$REPO_ROOT/mail-guide-ai-main/scripts/linux/selfhosted/"*.sh

cd "$REPO_ROOT" && git pull
```

**前置**：已安装 Docker Engine、Compose V2（`docker compose`）；`db push` 阶段需要本机 **Node 20+**。

### 2.1 生成 `supabase-selfhost` 目录（仅首次）

脚本从 Supabase 官方仓库拉取 `docker/` 模板到 `$REPO_ROOT/supabase-selfhost/`：

```bash
"$REPO_ROOT/mail-guide-ai-main/scripts/linux/bootstrap-supabase-docker.sh"
```

- 已存在 `supabase-selfhost/docker-compose.yml` → **跳过**。
- **重装**：先备份 `.env` 与 `volumes/`，删除整个 `supabase-selfhost` 后再执行。

### 2.2 配置 `.env` 与密钥

```bash
cd "$REPO_ROOT/supabase-selfhost"
cp -n .env.example .env    # .env 已存在时不要覆盖
sh ./utils/generate-keys.sh
```

必核对项（错一项易导致登录或跳转失败）：

| 变量 | 说明 |
|------|------|
| `SUPABASE_PUBLIC_URL` | 对外访问 **Kong** 的基址 |
| `API_EXTERNAL_URL` | 与 `SUPABASE_PUBLIC_URL` **相同** |
| `SITE_URL` | 用户打开 **mail-guide-ai 工作台** 的地址（与第三节前端一致） |
| `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` | **Studio** 登录；密码**不能纯数字** |
| `POSTGRES_PASSWORD` | 第四节 `db push` 使用；请妥善保存 |
| `ANON_KEY` / `SERVICE_ROLE_KEY` | 第四节脚本与前端配置会用到 |

### 2.3 启动全栈

```bash
cd "$REPO_ROOT/supabase-selfhost"
docker compose pull
docker compose up -d
docker compose ps
```

`db`、`kong` 等应为 **Up**（**healthy** 更佳）。

**Kong / Pooler 起不来**（日志含 `carriage return`）：

```bash
"$REPO_ROOT/mail-guide-ai-main/scripts/linux/fix-supabase-selfhost-crlf.sh"
cd "$REPO_ROOT/supabase-selfhost"
docker compose up -d --force-recreate kong supavisor
```

**宿主机 5432 被占用**：`.env` 设 `POOLER_PORT_PUBLISHED=54322`，并按 [`mail-guide-ai-main/docs/self-hosted-supabase.md`](../mail-guide-ai-main/docs/self-hosted-supabase.md) 改 `supavisor` 端口映射；**不要**改容器内 `POSTGRES_PORT`。

### 2.4 验收（本节做完应满足）

- 浏览器打开 `SUPABASE_PUBLIC_URL`（如 `http://<IP>:8000`）可进 **Studio**，用 `DASHBOARD_*` 登录。

---

## 三、部署 mail-guide-ai 前端

> 须在第二节 Kong 已启动、且已从 `supabase-selfhost/.env` 拿到 **`ANON_KEY`** 后执行。完整业务还依赖第四节库表与 Functions。

### 3.1 配置环境变量

编辑 `$REPO_ROOT/mail-guide-ai-main/.env`（可复制 `.env.selfhosted.example`）：

```env
VITE_SUPABASE_URL=<与 SUPABASE_PUBLIC_URL 一致>
VITE_SUPABASE_PUBLISHABLE_KEY=<supabase-selfhost/.env 中的 ANON_KEY>
VITE_SUPABASE_PROJECT_ID=self-hosted
```

`SITE_URL`（第二节 `.env`）须与用户实际打开前端的地址一致。

### 3.2 构建并启动

```bash
cd "$REPO_ROOT/mail-guide-ai-main"
docker compose build
docker compose up -d
```

默认访问：**`http://<主机>:8080`**。

### 3.3 注意

- 修改任意 **`VITE_*`** 后必须重新 **`docker compose build`** 再 `up -d`。
- 工作台用户使用 **Supabase Auth** 注册/登录（**不是** Studio 的 `DASHBOARD_*`）；首个注册用户为 **admin**。

### 3.4 验收（本节做完应满足）

- 浏览器打开工作台可看到登录页；第四节全部完成后可完成注册/登录。

---

## 四、部署后必跑脚本（库表、定时任务、Edge Functions）

> **第二节 Supabase 已 `up -d` 之后**按下列顺序执行。本节完成后，**数据表、RLS、Vault、pg_cron、全部业务 Edge Functions** 才构成完整可运行架构。

### 4.1 数据库迁移（全部表结构）

**步骤 1**：在 `$REPO_ROOT/supabase-selfhost/docker-compose.yml` 的 **`db:`** 服务下**临时**增加：

```yaml
    ports:
      - "54323:5432"
```

```bash
cd "$REPO_ROOT/supabase-selfhost"
docker compose up -d db
```

**步骤 2**：应用 `mail-guide-ai-main/supabase/migrations/` 下全部 SQL：

```bash
cd "$REPO_ROOT/mail-guide-ai-main"
export PGSSLMODE=disable
npx supabase db push \
  --db-url "postgresql://postgres:<POSTGRES_PASSWORD>@127.0.0.1:54323/postgres"
```

将 `<POSTGRES_PASSWORD>` 换为第二节 `.env` 中的值；密码含特殊字符需 URL 编码。

**步骤 3**：**删除**临时 `ports: "54323:5432"`，避免 Postgres 长期暴露：

```bash
cd "$REPO_ROOT/supabase-selfhost"
docker compose up -d db
```

### 4.2 Vault + pg_cron（必做，紧接 4.1）

仅执行 `db push` 时，定时任务 URL 可能仍指向云端；须改成本栈 Kong：

```bash
"$REPO_ROOT/mail-guide-ai-main/scripts/linux/selfhosted/apply-vault-and-cron.sh"
```

脚本会：写入 vault 中的 `service_role_key`；注册 **5 条** 定时任务，调用栈内 `http://kong:8000/functions/v1/...`。

| 定时任务名 | 调用的 Edge Function |
|------------|----------------------|
| `auto-sync-mailbox-every-5min` | `sync-mailbox` |
| `auto-draft-every-30min` | `schedule-draft-generation` |
| `compensating-alerts-every-30min` | `schedule-compensating-alerts` |
| `run-compensation-tasks-every-30min` | `run-compensation-tasks` |
| `retry-risk-intercept-hourly-at-45` | `retry-risk-intercept-compensation` |

### 4.3 Edge Functions 环境（仅首次）

```bash
"$REPO_ROOT/mail-guide-ai-main/scripts/linux/selfhosted/ensure-functions-env-in-compose.sh"
```

为 `functions` 服务挂载 **`supabase-selfhost/.env.functions`**。若无该文件，从  
`mail-guide-ai-main/docs/self-hosted-env-functions.example` 复制，并按交付清单填写，例如：

- **`ERP_*`**：订单/网关接口
- **邮箱相关**：IMAP/SMTP 等
- **`DIFY_*`**：现网 Dify 工作流 URL 与 Key（本期不部署 Dify 容器时仍须填现网值）

勿将 `.env.functions` 提交 Git。

### 4.4 同步并发布全部 Edge Functions

```bash
"$REPO_ROOT/mail-guide-ai-main/scripts/linux/sync-functions-to-selfhost.sh"
cd "$REPO_ROOT/supabase-selfhost"
docker compose up -d --force-recreate --no-deps functions
docker compose logs functions --tail 50
```

同步脚本会把 `mail-guide-ai-main/supabase/functions/` 下业务目录复制到 `supabase-selfhost/volumes/functions/`，主要包括：

`sync-mailbox`、`process-email`、`generate-draft`、`send-reply`、`test-mailbox`、`dify-gateway`、`risk-intercept`、`schedule-draft-generation`、`schedule-compensating-alerts`、`run-compensation-tasks`、`retry-risk-intercept-compensation`、`get-order-by-email`、`get-email-context`、`close-email`、`delete-mailbox`、`cleanup-emails` 及共享模块 `_shared/`。

官方模板自带的 **`hello`**、**`main`** 入口目录保留，勿删。

### 4.5 全架构验收（第四节做完必做）

**（1）Functions 经 Kong 可达**

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  "http://127.0.0.1:8000/functions/v1/hello"
```

预期 **HTTP 200**（端口以实际 `SUPABASE_PUBLIC_URL` 为准）。

**（2）定时任务指向自建，非云端**

在 Studio → SQL：

```sql
SELECT jobname, schedule, LEFT(command, 100) AS cmd
FROM cron.job
WHERE jobname IN (
  'auto-sync-mailbox-every-5min',
  'auto-draft-every-30min',
  'compensating-alerts-every-30min',
  'run-compensation-tasks-every-30min',
  'retry-risk-intercept-hourly-at-45'
)
ORDER BY jobname;
```

预期 **5 行**；`cmd` 中**不得**出现 `*.supabase.co`。

**（3）业务冒烟**

- Studio 可登录，Database 中可见业务表。
- 第三节工作台可注册/登录。
- 按交付范围测试：邮箱连接、收信、ERP（若本期包含）。

网络、HTTPS 反代、备份见 [`production-go-live.md`](./production-go-live.md)。

---

## 五、日常发版（栈已在跑）

先执行 **§2.0** `git pull`，再按变更类型选做：

| 变更 | 操作 |
|------|------|
| 仅有新 SQL 迁移 | 重复 **§4.1**，再执行 **§4.2** |
| 仅有 Functions 代码 | **§4.4** 前两行（sync + 重建 `functions`） |
| 仅改 `.env.functions` | `cd supabase-selfhost` → `docker compose up -d --force-recreate --no-deps functions` |
| 仅改前端 `VITE_*` | **§3.2** 重新 `build` + `up -d` |
| 研发未说明类型 | 按顺序：**§4.1 → §4.2 → §4.4 → §3.2**（无对应变更可跳过） |

---

## 六、登录地址速查

| 用途 | URL | 账号 |
|------|-----|------|
| **Supabase Studio** | `SUPABASE_PUBLIC_URL` | `.env` 的 `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` |
| **mail-guide-ai 工作台** | 与 `SITE_URL` 一致 | Auth 注册用户 |

---

## 七、常见排错

| 现象 | 处理 |
|------|------|
| `db push` 连不上 | 确认 §4.1 已临时映射 `54323:5432` 且 `db` 容器 Up |
| 有表但定时任务不跑 | 补跑 **§4.2** `apply-vault-and-cron.sh` |
| Functions 502 | `docker compose logs functions --tail 100`；检查 `.env.functions` |
| Kong 启动失败 + CRLF | **§2.3** `fix-supabase-selfhost-crlf.sh` |
| 宿主机 5432 冲突 | `POOLER_PORT_PUBLISHED=54322`，见 `self-hosted-supabase.md` |

更细排错：[`mail-guide-ai-main/docs/self-hosted-supabase.md`](../mail-guide-ai-main/docs/self-hosted-supabase.md)。

---

**文档版本**：与仓库同步；**不含 Dify 容器部署**。
