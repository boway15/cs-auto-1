# 运维手册：新服务器 Docker 一键拉栈（1.0 · 前端 + 自建 Supabase）

**文档用途**：给 **运维** 在目标机上把 **mail-guide-ai** 与 **自建 Supabase** 布置好并 **跑起来**，供业务验收。  
**不覆盖**：在本机部署 Dify 容器（现网 Dify 已有时，只需在配置里填 URL/Key）；**不包含** 数据库 schema 的 `db push` 迁移步骤（见 **「与研发/DBA 分工」**）。

深度排错与迁移命令见文末 **「相关文档」**。

---

## 一、运维目标（跑起来长什么样）

| 交付项 | 运维自检（默认未做 HTTPS 反代时） |
|--------|-----------------------------------|
| **Supabase 栈** | 浏览器能打开 **`SUPABASE_PUBLIC_URL`**（一般为 `http://<服务器IP或域名>:8000`），出现 **Studio 登录页** |
| **业务 API / 函数** | 同一 Kong 入口下，Edge Functions 经网关可达（详见 **§六 验收**） |
| **工作台前端** | 浏览器能打开 **`http://<服务器IP或域名>:8080`**（端口以 `mail-guide-ai-main/docker-compose.yml` 为准），能 **注册/登录** |

**说明**：业务逻辑在 **Edge Functions**（容器 `functions`）里，没有单独的 Java/Node「业务后端」进程要起。

---

## 二、与研发 / DBA 分工（上线前对齐）

| 事项 | 谁负责 | 运维需要拿到什么 |
|------|--------|------------------|
| **Postgres 里已有业务库结构**（表、RLS、扩展等） | 研发 / DBA / 发布流水线 | 确认 **1.0 上线前** 库已就绪：例如 **备份恢复**、**逻辑导入**、或已挂载含数据的 **Docker 卷**。若是 **全新空库**，须先按 [`self-hosted-supabase.md`](../mail-guide-ai-main/docs/self-hosted-supabase.md)「四步：数据库迁移」执行，**不在本文步骤内**。 |
| **现网 Dify 的 Workflow URL + API Key** | 研发 / AI 负责人 | 写入 **`supabase-selfhost/.env.functions`**（变量名见 [`self-hosted-env-functions.example`](../mail-guide-ai-main/docs/self-hosted-env-functions.example)） |
| **`DIFY_GATEWAY_API_KEY`（应用层网关密钥）** | **运维本机随机生成**（非 Dify 下发） | 写入 **`supabase-selfhost/.env.functions`**，生成命令见 **§四 步骤 5b**；验收见 **§六 6.2、6.3**（含 **`gateway_api_key`** 链路） |
| **ERP、邮箱等密钥** | 研发 / 业务 | 同上，写入 **`.env.functions`**，**勿提交 Git** |
| **`ANON_KEY`（给前端的 publishable key）** | 运维在生成 `.env` 后从 **`supabase-selfhost/.env`** 复制给前端配置 | 填入 **`mail-guide-ai-main/.env`** 的 `VITE_SUPABASE_PUBLISHABLE_KEY` |

---

## 三、环境要求（目标机）

- **Docker** + **`docker compose`**
- **Git**（执行 `generate-keys.sh` 等官方脚本时用 **Bash**；在 Windows 上可配合 **Git Bash** 或 **WSL**）
- **PowerShell**（仅 **Windows** 目标机：执行仓库内 `mail-guide-ai-main/scripts/*.ps1`）
- **CentOS / RHEL / 通用 Linux**：无需 PowerShell，使用 **`mail-guide-ai-main/scripts/linux/`** 下 Bash 脚本，步骤见 **「三附」**。
- 内存建议 **≥4GB**（生产建议 **8GB+**）

**路径约定**：下文 **`REPO_ROOT`** = 本仓库根目录在服务器上的绝对路径（Windows 例：`d:\Docker\project\cs-main`；Linux 例：`/opt/cs-main`）。所有命令在 **`REPO_ROOT`** 下按需 `cd` 执行。

---

## 三附、CentOS / RHEL / Linux（Bash，与 §四 等价）

**适用**：目标机为 **CentOS 7/8、RHEL、AlmaLinux、Rocky** 等，已安装 **Docker Engine** 与 **Compose V2**（`docker compose` 子命令可用）。

**脚本位置**：`mail-guide-ai-main/scripts/linux/`（与 Windows 版 `*.ps1` 一一对应，逻辑一致）。首次使用前赋予执行权限：

```bash
cd "$REPO_ROOT/mail-guide-ai-main/scripts/linux"
chmod +x *.sh selfhosted/*.sh
```

**建议依赖**（各脚本会按需调用）：`bash`、`git`、`docker`、`curl`、`openssl`、`awk`、`sed`、`tr`；`erp-fetch-prod-token.sh` 需要 **python3**；`fix-supabase-selfhost-crlf.sh` 若有 **perl** 会优先用其批量去 `\r`（无则退回 `sed`）。

**与 §四 步骤对照**（路径按 Linux 写法；假设已 `cd "$REPO_ROOT"`）：

| §四 步骤 | Linux / CentOS 命令 |
|----------|---------------------|
| 步骤 0 | `git pull`（同 §四 思路） |
| 步骤 1 | `mail-guide-ai-main/scripts/linux/bootstrap-supabase-docker.sh` |
| 步骤 2 | 仍在本机 Bash 执行：`cd "$REPO_ROOT/supabase-selfhost"` → `sh ./utils/generate-keys.sh`（与 §四 一致） |
| 步骤 3 | `cd "$REPO_ROOT/supabase-selfhost"` → `docker compose pull` → `docker compose up -d` |
| 步骤 3 排错（CRLF） | `mail-guide-ai-main/scripts/linux/fix-supabase-selfhost-crlf.sh`，再 `docker compose up -d --force-recreate kong supavisor` |
| 步骤 4 | `mail-guide-ai-main/scripts/linux/selfhosted/apply-vault-and-cron.sh` |
| 步骤 5a | `mail-guide-ai-main/scripts/linux/selfhosted/ensure-functions-env-in-compose.sh` |
| 步骤 5b | 仍手动复制 [`self-hosted-env-functions.example`](../mail-guide-ai-main/docs/self-hosted-env-functions.example) → `supabase-selfhost/.env.functions`，并按 **§四 步骤 5b** 用 `openssl rand -base64 32` 等生成 **`DIFY_GATEWAY_API_KEY`** |
| 步骤 5c | `mail-guide-ai-main/scripts/linux/sync-functions-to-selfhost.sh`，再 `cd "$REPO_ROOT/supabase-selfhost"` → `docker compose up -d --force-recreate --no-deps functions` |
| 步骤 6 | 与 §四 相同：配置 `mail-guide-ai-main/.env` 后在该目录 `docker compose build` → `docker compose up -d` |

**ERP 取生产 Token（可选，与 `erp-fetch-prod-token.ps1` 等价）**：

```bash
export ERP_USERNAME='...'
export ERP_PASSWORD='...'
# 可选：export ERP_CLIENT_ID=ERP
"$REPO_ROOT/mail-guide-ai-main/scripts/linux/erp-fetch-prod-token.sh"
```

**说明**：若官方 `docker-compose.yml` 中 **`functions`** 服务的 `restart` / `volumes` 块与仓库内 PowerShell 补丁脚本所匹配的正文不一致，`ensure-functions-env-in-compose.sh` 可能提示手工插入 `env_file: .env.functions`；按报错提示编辑 `docker-compose.yml` 即可。

---

## 四、按顺序执行（运维照抄）

### 步骤 0：拉代码

```powershell
cd $REPO_ROOT
git pull
```

（首次为 `git clone` 到 `$REPO_ROOT`，由项目组提供仓库地址与分支。）

---

### 步骤 1：生成 `supabase-selfhost` 目录（仅首次）

```powershell
cd $REPO_ROOT\mail-guide-ai-main\scripts
.\bootstrap-supabase-docker.ps1
```

**成功标志**：出现目录 **`$REPO_ROOT\supabase-selfhost\`**，其中有 `docker-compose.yml`。  
**重装**：须先备份 `.env` 与数据卷，删除整个 `supabase-selfhost` 后再执行。

---

### 步骤 2：配置 `supabase-selfhost/.env` 与密钥

1. 复制：`supabase-selfhost\.env.example` → `supabase-selfhost\.env`

2. 在 **Git Bash 或 WSL** 中：

   ```bash
   cd /path/to/REPO_ROOT/supabase-selfhost
   sh ./utils/generate-keys.sh
   # 若官方模板要求：
   # sh ./utils/add-new-auth-keys.sh
   ```

3. 用编辑器打开 **`supabase-selfhost/.env`**，确认与现网一致（**错一项容易导致登录跳转失败**）：

| 变量 | 填什么 |
|------|--------|
| `SUPABASE_PUBLIC_URL` | 用户与前端访问 **Kong** 的对外地址（生产多为 **HTTPS 反代后的根 URL**） |
| `API_EXTERNAL_URL` | 一般与 `SUPABASE_PUBLIC_URL` **相同** |
| `SITE_URL` | 用户浏览器打开 **工作台前端** 的地址（与实际上线 URL 一致，如 `https://app.example.com`） |
| `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` | Studio 登录；**密码勿纯数字** |

HTTPS 反代见官方：[Self-Hosted Proxy HTTPS](https://supabase.com/docs/guides/self-hosting/self-hosted-proxy-https)。

---

### 步骤 3：启动 Supabase 全栈

```powershell
cd $REPO_ROOT\supabase-selfhost
docker compose pull
docker compose up -d
docker compose ps
```

**成功标志**：`db`、`kong`、`functions` 等为 **Up**（有 health 的显示 **healthy**）。浏览器打开 **`SUPABASE_PUBLIC_URL`** 能看到 Studio。

**若失败**，先试下面两条（仍失败则翻 **§五** 或 `self-hosted-supabase.md`）：

- **5432 被占用**：不要改容器内 `POSTGRES_PORT`；按 [`self-hosted-supabase.md`](../mail-guide-ai-main/docs/self-hosted-supabase.md) 配置 **`POOLER_PORT_PUBLISHED`** 并改 compose 里 **supavisor** 映射。
- **Kong / Pooler CRLF**（Windows 常见）：

```powershell
cd $REPO_ROOT\mail-guide-ai-main\scripts
.\fix-supabase-selfhost-crlf.ps1
cd $REPO_ROOT\supabase-selfhost
docker compose up -d --force-recreate kong supavisor
```

---

### 步骤 4：Vault + 定时任务（必做）

**前提**：**§二** 中数据库已为业务库；否则脚本可能失败或定时任务无效。

```powershell
cd $REPO_ROOT\mail-guide-ai-main\scripts\selfhosted
.\Apply-VaultAndCron.ps1
```

**作用简述**：对齐 vault 里的 `service_role_key`；把 pg_cron 里任务指到 **本机 Kong**（如 `http://kong:8000/functions/v1/...`），**不能**残留 `*.supabase.co`。  
**验证**：[`mail-guide-ai-main/docs/startup-commands.md`](../mail-guide-ai-main/docs/startup-commands.md)「验证清单」中的 SQL。

---

### 步骤 5：Functions 环境文件 + 业务密钥（一次性 + 每次密钥变更）

**5a** 仅第一次执行（会改 **`supabase-selfhost/docker-compose.yml`**，给 `functions` 挂上 `env_file`）：

```powershell
cd $REPO_ROOT\mail-guide-ai-main\scripts\selfhosted
.\Ensure-FunctionsEnvFileInCompose.ps1
```

**5b** 复制模板并填写（由研发提供具体值）：

- 将 [`mail-guide-ai-main/docs/self-hosted-env-functions.example`](../mail-guide-ai-main/docs/self-hosted-env-functions.example) 复制为 **`supabase-selfhost/.env.functions`**
- **`DIFY_GATEWAY_API_KEY`（须本机或安全终端先生成，不是 Dify 控制台里的 `app-` 密钥）**  
  - **用途**：`dify-gateway` Edge 校验请求头 `x-api-key`；调用草稿工作流时由 Edge 把 **同一字符串** 作为工作流输入 **`gateway_api_key`** 传给 Dify，供工作流内 HTTP 节点回调网关时使用（**环境变量名与 Dify 输入变量名不同，值为同一把密钥**）。  
  - **Windows：在运维本机 PowerShell 执行**（任意目录均可，无需登录服务器）：

    ```powershell
    [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
    ```

  - **CentOS / RHEL / AlmaLinux / Rocky 等**：在 **Bash** 中执行（需已安装 **`openssl`**；最小化镜像可先 `sudo yum install -y openssl` 或 `sudo dnf install -y openssl`）：

    ```bash
    openssl rand -base64 32
    ```

    若无 `openssl`，可用系统随机设备（输出亦为 Base64 形态，长度略异无妨，整行粘贴即可）：

    ```bash
    head -c 32 /dev/urandom | base64
    ```

  - **其它 Linux / Git Bash**：与上一项相同，优先 `openssl rand -base64 32`（与 §三附 工具链一致）。  
  - 将终端输出的 **整行**（勿含换行与首尾空格）粘贴到 **`DIFY_GATEWAY_API_KEY=`** 之后；**勿提交 Git**、勿贴工单明文。轮换密钥后须同步重建 **`functions`** 容器（见 **5c** / 文末「仅改 `.env.functions`」说明）。  
  - **测试环境生成的密钥能否直接用于生产？** **技术上可以**：只要生产环境 **`supabase-selfhost/.env.functions`** 中填入 **同一字符串**，且 Dify 工作流仍通过 **`gateway_api_key` / `x-api-key`** 与网关一致，功能即正常。**安全上不建议**：测试与生产共用一把钥匙时，测试环境泄露、误配或多人可见会 **连带危及生产**；生产上线建议 **单独再生成一把** 并只写入生产 `.env.functions`，测试环境保留原值互不影响。
- 填写其余 Dify（`DIFY_*_URL` / `DIFY_*_KEY`）、ERP、邮箱等（**勿提交 Git**）；分析与草稿应用的 URL/Key **不可混用**。

**5c** 同步函数代码并重建 `functions` 容器：

```powershell
cd $REPO_ROOT\mail-guide-ai-main\scripts
.\sync-functions-to-selfhost.ps1

cd $REPO_ROOT\supabase-selfhost
docker compose up -d --force-recreate --no-deps functions
```

**仅改了 `.env.functions`、没改 TS 源码** 时，可 **跳过** `sync-functions-to-selfhost.ps1`，只执行上面最后一行 **`--no-deps functions`**。

---

### 步骤 6：构建并启动前端

**6a** 复制前端环境模板：

- [`mail-guide-ai-main/.env.selfhosted.example`](../mail-guide-ai-main/.env.selfhosted.example) → **`mail-guide-ai-main/.env`**

**6b** 编辑 **`mail-guide-ai-main/.env`**（与 **`supabase-selfhost/.env`** 一致对外）：

```env
VITE_SUPABASE_URL=<与 SUPABASE_PUBLIC_URL 一致，含协议与端口>
VITE_SUPABASE_PUBLISHABLE_KEY=<supabase-selfhost/.env 中的 ANON_KEY>
VITE_SUPABASE_PROJECT_ID=self-hosted
```

**6c** 构建并启动：

```powershell
cd $REPO_ROOT\mail-guide-ai-main
docker compose build
docker compose up -d
```

改任意 **`VITE_*`** 后必须重新 **`docker compose build`**。

---

## 五、日常运维常用命令

```powershell
# Supabase 栈状态
cd $REPO_ROOT\supabase-selfhost
docker compose ps

# 看最近日志（排错）
docker compose logs kong --tail 100
docker compose logs functions --tail 100
docker compose logs db --tail 80

# 改全局 .env 后尝试整体拉起
docker compose up -d
```

**服务器重启后**只需：

```powershell
cd $REPO_ROOT\supabase-selfhost
docker compose up -d

cd $REPO_ROOT\mail-guide-ai-main
docker compose up -d
```

---

## 六、部署后密钥与配置检查（验收打勾）

上线交接前，建议由 **运维 + 研发** 共同核对下列项；**任一项缺失都可能导致 Dify 草稿、网关回调或登录异常**。

### 6.1 `supabase-selfhost/.env`（Supabase 栈根配置）

- [ ] **`JWT_SECRET` / `ANON_KEY` / `SERVICE_ROLE_KEY`** 等已由 `utils/generate-keys.sh` 生成，且复制到前端时 **未截断、未混用其它环境**  
- [ ] **`SUPABASE_PUBLIC_URL`、`API_EXTERNAL_URL`、`SITE_URL`** 与实际上线访问方式一致（HTTPS 反代后与真实域名一致）  
- [ ] **`DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`** 已设且符合安全要求（密码勿纯数字）  

### 6.2 `supabase-selfhost/.env.functions`（Edge 业务密钥）

- [ ] **Dify 工作流 API**：`DIFY_ANALYZE_URL` + `DIFY_ANALYZE_KEY`、`DIFY_DRAFT_URL` + `DIFY_DRAFT_KEY` 已填；**分析应用与草稿应用的 URL/Key 不可混用**  
- [ ] **`DIFY_GATEWAY_API_KEY`**：已按 **§四 步骤 5b** 在本机或服务器终端生成并写入；**不是** Dify 应用 API 密钥（`app-xxxx`）。**推荐** 与测试环境 **分钥**（见 **§四 步骤 5b** 末段「测试与生产是否复用」）  
- [ ] **`DIFY_GATEWAY_URL`（若填写）**：与 Dify 工作流中回调 **`dify-gateway`** 的地址 **一致**；**云端 Dify** 须使用 **公网可达的 HTTPS**（如 `https://<Kong 对外域名>/functions/v1/dify-gateway`），**不可**依赖仅本机有效的 `host.docker.internal`（说明见 [`self-hosted-env-functions.example`](../mail-guide-ai-main/docs/self-hosted-env-functions.example)）  
- [ ] **ERP、邮箱、其它变量** 已按 [`self-hosted-env-functions.example`](../mail-guide-ai-main/docs/self-hosted-env-functions.example) 与研发清单补全  
- [ ] 修改 `.env.functions` 后已执行 **`docker compose up -d --force-recreate --no-deps functions`**（或含 **5c** 的完整同步），确保进程已加载最新环境变量  

### 6.3 `gateway_api_key` 与 Dify ↔ `dify-gateway` 链路

- [ ] **同一密钥三处一致**：`.env.functions` 中的 **`DIFY_GATEWAY_API_KEY`** = Edge 调用 Dify 时传入的 **`gateway_api_key`（工作流输入）** = Dify 内请求 `dify-gateway` 的 HTTP 头 **`x-api-key`**（以当前导入的 DSL 为准；若研发改过节点须重新对齐）  
- [ ] **研发 / AI**：Dify 草稿等工作流已 **发布**；从 **Dify 所在网络** 能访问 **`…/functions/v1/dify-gateway`**（防火墙/安全组放行 **Dify → 机 1 Kong**）  
- [ ] **抽样验证**：由研发在 Dify 或业务路径触发一次依赖网关的草稿/分析链路；若出现 **401 /「未授权」/「DIFY_GATEWAY_API_KEY 未配置」** 类日志，回到 **6.2、6.3** 与 [`mail-guide-ai-main/dify-workflows/README.md`](../mail-guide-ai-main/dify-workflows/README.md) 排错说明  

### 6.4 `mail-guide-ai-main/.env`（前端构建期变量）

- [ ] **`VITE_SUPABASE_URL`** 与 **`SUPABASE_PUBLIC_URL`** 一致（含协议与端口）  
- [ ] **`VITE_SUPABASE_PUBLISHABLE_KEY`** = 自建 **`supabase-selfhost/.env`** 中的 **`ANON_KEY`**  
- [ ] 修改任意 **`VITE_*`** 后已重新 **`docker compose build`**（见 §四 步骤 6）  

### 6.5 联通与功能（跑通）

- [ ] **`SUPABASE_PUBLIC_URL`** 浏览器可打开 Studio，`docker compose ps` 无异常退出  
- [ ] 已执行 **Vault + cron**（Windows：`Apply-VaultAndCron.ps1`；CentOS/Linux：`scripts/linux/selfhosted/apply-vault-and-cron.sh`），且与 [`startup-commands.md`](../mail-guide-ai-main/docs/startup-commands.md) 验证一致  
- [ ] **`http://<主机>:8080`**（或实际映射端口）可打开前端，**注册/登录**正常、无明显 CORS/跳转错误  
- [ ] 由研发确认：**Functions 出站** 可达现网 Dify、邮箱、ERP（网络与安全组见 [`production-go-live.md`](production-go-live.md) 第二节）

---

## 七、架构速览（供运维理解，非执行步骤）

| 组件 | 路径 / 说明 | 默认端口（未反代） |
|------|-------------|-------------------|
| 自建 Supabase | `$REPO_ROOT\supabase-selfhost`，`docker compose` 管理 | Kong **8000** |
| 前端 | `$REPO_ROOT\mail-guide-ai-main`，`docker compose` 管理 | **8080** → 容器 80 |
| 业务逻辑 | `mail-guide-ai-main/supabase/functions/`，同步进自建卷后由 **`functions`** 容器运行 | 经 Kong **8000** 访问 |

自建发布函数：**同步脚本 + 重建 `functions`**；**不要**对自建库执行 `npx supabase functions deploy`（该命令用于 Supabase Cloud）。

---

## 八、相关文档

| 说明 | 路径 |
|------|------|
| 自建 Supabase 全流程（**含数据库迁移**） | [`mail-guide-ai-main/docs/self-hosted-supabase.md`](../mail-guide-ai-main/docs/self-hosted-supabase.md) |
| 命令与验证 SQL 速查 | [`mail-guide-ai-main/docs/startup-commands.md`](../mail-guide-ai-main/docs/startup-commands.md) |
| 生产网络、TLS、上线核对 | [`docs/production-go-live.md`](production-go-live.md) |
| 根目录命令速查 | [`DEPLOY.md`](../DEPLOY.md) |

---

*主要读者：运维；与仓库路径 `docs/docker-deploy-new-server.md` 同步维护。*
