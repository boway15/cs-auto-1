# 运维手册：中间件、自建 Supabase 与全栈部署流程（CentOS / Linux）

**读者**：生产/验收环境运维  
**本期范围**：**不包含 Dify 的安装与部署**；手册仅覆盖 **自建 Supabase** + **mail-guide-ai 前端** 及与之直接相关的运维步骤。  
**路径约定**：`REPO_ROOT` = 本仓库在服务器上的绝对路径（示例：`/opt/cs-main`）。下文命令均在 Linux / Bash 下执行，除非另行说明。

**不替代**：更细的排错、迁移与分工仍以下列文档为准，本手册做**汇总与照抄顺序**：

| 文档 | 说明 |
|------|------|
| [`docker-deploy-new-server.md`](./docker-deploy-new-server.md) | 新服务器拉栈、**三附 CentOS 与 ps1 对照** |
| [`production-go-live.md`](./production-go-live.md) | 生产上线准备、网络、验收、备份 |
| [`../DEPLOY.md`](../DEPLOY.md) | 常用命令速查（文中多为 Windows 路径，Linux 请改 `$REPO_ROOT/...`） |
| [`../mail-guide-ai-main/docs/self-hosted-supabase.md`](../mail-guide-ai-main/docs/self-hosted-supabase.md) | 自建 Supabase 全流程、端口、`db push`、Functions |
| [`../mail-guide-ai-main/docs/startup-commands.md`](../mail-guide-ai-main/docs/startup-commands.md) | 启动顺序与验证 SQL |

---

## 一、架构与中间件一览

### 1.1 本期部署拓扑

| 范围 | 内容 |
|------|------|
| **本机 / 本仓库** | **自建 Supabase**（`supabase-selfhost`）+ **mail-guide-ai 前端**（Docker） |

业务 API 在 **Supabase Edge Functions**（容器 `functions`，Deno），**无**单独 Java/Node 业务后端进程。

### 1.2 机 1：`supabase-selfhost` 栈内中间件（容器）

以下服务来自官方 `docker-compose.yml`（服务名以实际 compose 为准）：

| 组件 | 作用简述 |
|------|----------|
| **kong** | API 网关；对外 REST、Auth、Storage、Realtime、Functions、Studio 等多经此入口 |
| **db** | PostgreSQL |
| **supavisor** | 连接池（会话/事务模式）；注意宿主机端口可能与本机已有 5432 冲突 |
| **auth** | GoTrue，用户注册/登录/JWT |
| **rest** | PostgREST |
| **realtime** | Realtime |
| **storage** | 对象存储 API |
| **imgproxy** | 图片处理 |
| **meta** | pgmeta（Studio 用） |
| **functions** | Edge Functions 运行时（业务逻辑） |
| **studio** | Supabase Studio 管理界面 |
| **vector** | 向量相关（若模板启用） |
| **analytics** | Logflare 等分析组件 |

### 1.3 机 1：mail-guide-ai 前端

| 组件 | 说明 |
|------|------|
| **mail-guide-ai 容器** | 多阶段构建：**Node `npm run build`（Vite）** → **Nginx** 托管静态文件；默认 **`8080:80`**（以 `mail-guide-ai-main/docker-compose.yml` 为准） |

### 1.4 外部依赖（非本机容器）

- **ERP**、**邮箱（IMAP/SMTP）** 等：由 `functions` 容器**出站**访问；防火墙与安全组需放行（详见 `production-go-live.md`）。

---

## 二、`supabase-selfhost` 目录如何生成

**来源**：非手抄，由脚本从 Supabase 官方仓库 **sparse clone `docker/`** 复制到 **`$REPO_ROOT/supabase-selfhost/`**。

**首次生成（Linux）**：

```bash
export REPO_ROOT=/opt/cs-main
cd "$REPO_ROOT"
git pull

chmod +x "$REPO_ROOT/mail-guide-ai-main/scripts/linux/"*.sh \
         "$REPO_ROOT/mail-guide-ai-main/scripts/linux/selfhosted/"*.sh

"$REPO_ROOT/mail-guide-ai-main/scripts/linux/bootstrap-supabase-docker.sh"
```

- 若已存在 `supabase-selfhost/docker-compose.yml`，脚本会提示 **Already exists** 并退出；**重装**须先备份 `.env` 与数据卷，**删除整个 `supabase-selfhost`** 后再执行。

**生成后目录内应有**：`docker-compose.yml`、`utils/`（含 `generate-keys.sh`）、`volumes/`、`dev/` 等与官方 Docker 自建模板一致的内容。

---

## 三、运维主流程（建议顺序）

以下与 [`docker-deploy-new-server.md`](./docker-deploy-new-server.md) **§四 / 三附** 对齐，命令统一为 **Bash**。

### 步骤 0：代码

```bash
cd "$REPO_ROOT"
git pull
```

### 步骤 1：生成 `supabase-selfhost`（仅首次）

见 **第二节**。已存在则跳过。

### 步骤 2：配置 `supabase-selfhost/.env` 与密钥

```bash
cd "$REPO_ROOT/supabase-selfhost"
cp -n .env.example .env   # 若 .env 已存在请勿覆盖
sh ./utils/generate-keys.sh
# 若官方模板要求非对称密钥，再执行：
# sh ./utils/add-new-auth-keys.sh
```

用编辑器核对 `.env`（**错一项易导致登录跳转失败**），至少包括：

| 变量 | 说明 |
|------|------|
| `SUPABASE_PUBLIC_URL` | 用户与前端访问 **Kong** 的对外基址（生产多为 HTTPS 反代后 URL） |
| `API_EXTERNAL_URL` | 一般与 `SUPABASE_PUBLIC_URL` **相同** |
| `SITE_URL` | 用户浏览器打开 **mail-guide-ai 工作台** 的基址（须与实际上线 URL 一致） |
| `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` | **Studio** 登录；**密码勿纯数字** |
| `POSTGRES_PASSWORD` 等 | 按官方模板与内控要求设置 |

HTTPS 反代：见官方 [Self-Hosted Proxy HTTPS](https://supabase.com/docs/guides/self-hosting/self-hosted-proxy-https)。

### 步骤 3：启动 Supabase 全栈

```bash
cd "$REPO_ROOT/supabase-selfhost"
docker compose pull
docker compose up -d
docker compose ps
```

**常见排错**：

- **5432 被占用**：勿改容器内 `POSTGRES_PORT`；按 `self-hosted-supabase.md` 使用 **`POOLER_PORT_PUBLISHED`** 并改 `supavisor` 的 `ports` 映射。
- **Kong / Pooler CRLF**（从 Windows 拷贝文件到 Linux 时也可能出现）：

```bash
"$REPO_ROOT/mail-guide-ai-main/scripts/linux/fix-supabase-selfhost-crlf.sh"
cd "$REPO_ROOT/supabase-selfhost"
docker compose up -d --force-recreate kong supavisor
```

### 步骤 4：数据库结构与 Vault / 定时任务

- **库结构**：由研发/DBA 使用 `mail-guide-ai-main/supabase/migrations` 执行 **`npx supabase db push`**（常需临时暴露 `db` 端口，**迁移后删除映射**）。细节见 `self-hosted-supabase.md`「四步」。
- **Vault + pg_cron（必做）**：对齐 `service_role_key`，定时任务指向 **本栈 Kong**（如 `http://kong:8000/functions/v1/...`），不得残留 `*.supabase.co`。

```bash
"$REPO_ROOT/mail-guide-ai-main/scripts/linux/selfhosted/apply-vault-and-cron.sh"
```

验证 SQL 见 `startup-commands.md`「验证清单」。

### 步骤 5：Edge Functions 与密钥

**5a**（仅首次，会修改 `supabase-selfhost/docker-compose.yml`，为 `functions` 挂载 `env_file`）：

```bash
"$REPO_ROOT/mail-guide-ai-main/scripts/linux/selfhosted/ensure-functions-env-in-compose.sh"
```

**5b** 复制并填写 **`supabase-selfhost/.env.functions`**：

- 将 [`../mail-guide-ai-main/docs/self-hosted-env-functions.example`](../mail-guide-ai-main/docs/self-hosted-env-functions.example) 复制为 **`$REPO_ROOT/supabase-selfhost/.env.functions`**。
- **本期**：按**项目交付清单**填写本期必需的变量（如 **`ERP_*`**、邮箱相关、以及 Edge 运行所需的其他项）。示例文件中若含有**本期不启用的 AI 工作流类变量**，以研发书面说明为准：可留空、占位或整段暂不配置，**勿提交 Git**。
- 需要运维本机生成的强随机密钥时，可用：

```bash
openssl rand -base64 32
```

**5c** 同步函数并重建 `functions`：

```bash
"$REPO_ROOT/mail-guide-ai-main/scripts/linux/sync-functions-to-selfhost.sh"
cd "$REPO_ROOT/supabase-selfhost"
docker compose up -d --force-recreate --no-deps functions
```

> 自建栈发布函数：**同步目录 + 重建容器**即可；**不需要** `npx supabase functions deploy`（该命令面向 Supabase Cloud）。

### 步骤 6：mail-guide-ai 前端

```bash
# 配置 mail-guide-ai-main/.env（可参考 .env.selfhosted.example）
# VITE_SUPABASE_URL = Kong 对外基址
# VITE_SUPABASE_PUBLISHABLE_KEY = supabase-selfhost/.env 中的 ANON_KEY（或当前 publishable key）

cd "$REPO_ROOT/mail-guide-ai-main"
docker compose build
docker compose up -d
```

默认浏览器访问 **`http://<主机>:8080`**（以 compose 端口为准）。**修改任意 `VITE_*` 后必须重新 `docker compose build`**。

### 步骤 7：验收与上线核对

按 [`docker-deploy-new-server.md`](./docker-deploy-new-server.md) **§六** 与 [`production-go-live.md`](./production-go-live.md) **§3.8** 执行；**本期**以 **Studio/Kong、Functions、`cron.job`、`vault`、前端注册登录、邮件/ERP 等与交付范围一致** 的项为准（全文若含 AI 工作流验收，本期不部署时可跳过或与研发单独约定）。

---

## 四、登录说明（运维须分清）

### 4.1 Supabase Studio（管理台）

| 项 | 说明 |
|----|------|
| **URL** | `SUPABASE_PUBLIC_URL`（如 `http://IP:8000` 或 HTTPS 反代根地址） |
| **账号** | `.env` 中 **`DASHBOARD_USERNAME`** |
| **密码** | `.env` 中 **`DASHBOARD_PASSWORD`**（须强密码，**不能纯数字**） |

### 4.2 mail-guide-ai 工作台（业务用户）

| 项 | 说明 |
|----|------|
| **URL** | 与 **`.env` 的 `SITE_URL`** 一致的前端地址（如 `https://app.example.com`） |
| **认证** | Supabase **Auth**（非 Studio 的 `DASHBOARD_*`） |
| **前端配置** | `mail-guide-ai-main/.env`：`VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY`（来自自建 `.env` 的 **`ANON_KEY`** 等） |

**首个注册用户**在当前实现中为 **admin**，之后新用户默认 **agent**（见 `production-go-live.md` 第四节）。

---

## 五、日常变更速查

| 变更类型 | 操作 |
|----------|------|
| 仅 Edge Functions 源码 | `sync-functions-to-selfhost.sh` → `docker compose up -d --force-recreate --no-deps functions` |
| 仅 `.env.functions` | 编辑后同上重建 `functions` |
| 仅 `supabase-selfhost/.env`（非 functions 段） | 视变量影响重启相关服务或整栈 `docker compose up -d` |
| 前端 `VITE_*` | `mail-guide-ai-main` 下 **`docker compose build`** 再 `up -d` |
| 数据库迁移 | 临时端口 + `npx supabase db push`（见 `self-hosted-supabase.md`） |

---

## 六、脚本与 Windows 对照

运维在 **Linux** 上使用 **`mail-guide-ai-main/scripts/linux/`** 下脚本，与 Windows 下 `*.ps1` 一一对应；完整对照表见 [`docker-deploy-new-server.md`](./docker-deploy-new-server.md) **「三附」**。

**ERP 取生产 Token（可选）**：

```bash
export ERP_USERNAME='...'
export ERP_PASSWORD='...'
"$REPO_ROOT/mail-guide-ai-main/scripts/linux/erp-fetch-prod-token.sh"
```

---

**文档版本**：与仓库当前结构同步；**本期不含 Dify 部署**。若官方 Supabase Docker 模板或 compose 服务名变更，以官方文档及本仓库 `self-hosted-supabase.md` 更新为准。
