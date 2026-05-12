# cs-main 生产上线准备与运维说明

本文档描述 **mail-guide-ai + 自建 Supabase（`supabase-selfhost`）+ Dify** 整体上线准备、上线后运维要点，以及 **邮箱 CA 链 PEM** 的后续事宜。  
**不替代**下列原文档，细节命令与排错仍以原文为准：

| 文档 | 路径 |
|------|------|
| 全栈命令速查 | 仓库根目录 [`DEPLOY.md`](../DEPLOY.md) |
| 启动顺序与 Cloud/自建命令 | [`mail-guide-ai-main/docs/startup-commands.md`](../mail-guide-ai-main/docs/startup-commands.md) |
| 自建 Supabase 全流程与清单 | [`mail-guide-ai-main/docs/self-hosted-supabase.md`](../mail-guide-ai-main/docs/self-hosted-supabase.md) |
| Functions 环境变量示例 | [`mail-guide-ai-main/docs/self-hosted-env-functions.example`](../mail-guide-ai-main/docs/self-hosted-env-functions.example) |

---

## 一、适用范围与架构前提

以下假设与当前规划一致（若变更请同步修订本文档「核对表」）：

- **Supabase**：生产使用 **自建** [`supabase-selfhost`](../supabase-selfhost/)（非 Supabase Cloud 主路径）。
- **部署拓扑**：**两台机器** —— **机 1** 运行 `supabase-selfhost`（及建议同区域部署的前端或反代）；**机 2 为已有 Dify 服务器**（环境与域名由现网运维维护）。本仓库 `dify/docker/docker-compose.cs.yml` 等仅作本地/参考栈，**生产 Dify 不要求在本仓库所在机器重新起一套**。
- **Dify 访问**：现网 **固定域名 + HTTPS**（按现网证书策略）；**不使用 ngrok**。上线时在本仓库 **导入工作流 DSL / 对齐应用配置** 即可（见 **3.1**）。
- **ERP**：生产正式环境；密钥仅写入 `supabase-selfhost/.env.functions`（或等价 secrets），**勿提交 Git**。
- **邮箱**：同时使用 **网易** 与 **Gmail 企业邮箱**；首轮上线可不强制已配置自定义 CA PEM（见 **第六节 后续事宜**）。
- **停机与备份**：可接受 **约 4 小时以内** 计划内停机；备份保留 **不少于 30 天**。

---

## 二、服务器需支持调用 Gmail

业务侧邮件同步与发送由 **机 1 上 Supabase Edge Functions（`functions` 容器）** 发起，需满足 **出站** 条件（安全组/防火墙/代理策略以 **机 1 出站** 为准，与 Dify 机无关）。

### 2.1 网络与端口

| 用途 | 主机名（常见） | 端口 | 协议说明 |
|------|----------------|------|------------|
| IMAP | `imap.gmail.com` | **993** | TLS（implicit） |
| SMTP | `smtp.gmail.com` | **587** | STARTTLS；或 **465**（SSL），以工作台实际配置为准 |

请放行 **机 1 → 上述 FQDN:端口** 的出站访问。若策略只能按域名放行，请使用 **域名维度**（Google 服务 IP 可能变动，不宜长期写死少量 IP）。

### 2.2 TLS 与时间

- 容器/宿主机 **系统时间准确**（NTP），避免证书校验失败。
- Gmail 使用公共 PKI，**通常无需** 在首轮上线前挂载自定义 CA 文件；若出口经 **TLS 解密代理** 导致 `UnknownIssuer` 等，按 **第六节** 配置 PEM。

### 2.3 与网易并存

- **Gmail** 与 **网易** 的出站目标不同，防火墙需 **分别允许** 各自 IMAP/SMTP 主机与端口（网易以服务商文档为准，常见为 `imap.*.com` / `smtp.*.com` 等）。

---

## 三、完整上线准备（按依赖顺序）

### 3.1 机 2：已有 Dify 服务器（导入与对接）

**前提**：Dify 已在独立服务器运行；本次上线 **不在此文档范围内** 重复搭建 Dify 操作系统级或集群级安装（由现网负责）。

1. **导入代码/工作流**：在现网 Dify 控制台中，将本仓库 [`mail-guide-ai-main/dify-workflows/`](../mail-guide-ai-main/dify-workflows/) 下对应 DSL **导入为应用/工作流**（或按团队流程从 Git 拉取后导入），发布为可 API 调用的版本。  
2. **密钥与入口**：在 Dify 中为「邮件智能分析」「邮件草稿生成」等应用分别取得 **Workflow API 密钥（`app-xxxx`）** 与 **对外 API 地址**（`.../v1/workflows/run` 等，以现网 Dify 版本为准）；**分析应用与草稿应用的 URL/Key 不可混用**。  
3. **域名与 HTTPS**：沿用现网 **固定域名** 与证书策略；若后续证书轮换，同步更新 `supabase-selfhost/.env.functions` 中的 `DIFY_*_URL`（若域名不变则通常只需关注 Key 与路径）。  
4. **连通性**：从 **机 1**（与生产 `functions` 容器出站一致）对现网 Dify 的 **HTTPS 工作流地址** 做测试（如 `curl`），确保防火墙/代理不拦截 **机 1 → 机 2**。  
5. **本地参考栈（可选）**：若开发人员需在笔记本复现全栈，仍可使用 [`DEPLOY.md`](../DEPLOY.md) 第三节的 `docker-compose.cs.yml`；**与生产现网 Dify 无必然同一套实例**。

### 3.2 机 1：自建 Supabase 栈

1. **密钥与 `.env`**：自 `supabase-selfhost/.env.example` 生成 `.env`；按官方说明执行 `utils/generate-keys.sh` 等（详见 [`self-hosted-supabase.md`](../mail-guide-ai-main/docs/self-hosted-supabase.md)「二步」）。
2. **对外 URL**：配置 `SUPABASE_PUBLIC_URL`、`API_EXTERNAL_URL`；`SITE_URL` 为浏览器访问 **mail-guide-ai 前端** 的基址（HTTPS 就绪后与真实域名一致）。
3. **端口冲突**：若宿主机 5432 已被占用，使用 `POOLER_PORT_PUBLISHED` 等方案（见 `self-hosted-supabase.md`）。
4. **启动栈**：`docker compose pull` → `docker compose up -d` → `docker compose ps`，主要服务 **healthy**。
5. **Windows CRLF**：若 Kong/Pooler 启动异常，执行 `mail-guide-ai-main/scripts/fix-supabase-selfhost-crlf.ps1` 后重建相关容器（见原文档）。

### 3.3 数据库迁移

1. 按 `self-hosted-supabase.md` 为 `db` **临时**暴露宿主机端口（如 `54323:5432`），执行：  
   `npx supabase db push --db-url "postgresql://postgres:<密码>@127.0.0.1:54323/postgres"`（`PGSSLMODE=disable` 等见原文档）。
2. **迁移完成后删除** `db` 的临时 `ports` 映射，避免 Postgres 长期暴露在宿主机。

### 3.4 Vault 与 pg_cron（必做）

在 **机 1** 执行：

```powershell
cd <仓库根>\mail-guide-ai-main\scripts\selfhosted
.\Apply-VaultAndCron.ps1
```

- 确认 `cron.job` 中存在 **4 条**业务任务，且 **`command` 中不得出现 `*.supabase.co`**（应指向本栈 Kong，如 `http://kong:8000/functions/v1/...`）。  
- 验证 SQL 见 [`startup-commands.md`](../mail-guide-ai-main/docs/startup-commands.md)「五、验证清单」。

### 3.5 Edge Functions 与 `.env.functions`

1. 同步函数：`mail-guide-ai-main/scripts/sync-functions-to-selfhost.ps1`。  
2. 若尚未注入 `env_file`：`mail-guide-ai-main/scripts/selfhosted/Ensure-FunctionsEnvFileInCompose.ps1`。  
3. 复制 [`self-hosted-env-functions.example`](../mail-guide-ai-main/docs/self-hosted-env-functions.example) 为 `supabase-selfhost/.env.functions`，至少配置：  
   - **Dify**：`DIFY_ANALYZE_URL` / `DIFY_ANALYZE_KEY`、`DIFY_DRAFT_URL` / `DIFY_DRAFT_KEY` 等（URL 为 **现网 Dify 固定域名 HTTPS**，与 3.1 中导入的工作流一致）。  
   - **ERP 正式**：`ERP_TOKEN_URL`、`ERP_OMS_BASE`、`ERP_GATEWAY_BASE`、账号与 `ERP_CLIENT_ID`、`ERP_TOKEN_PASSWORD_FIELD` 等。  
4. 重建 Functions：  
   `cd supabase-selfhost && docker compose up -d --force-recreate --no-deps functions`  
5. **安全**：`supabase/config.toml` 中部分函数为 `verify_jwt=false` 时，生产须配合 **网关限源、内网调用或独立密钥**，避免公网裸调（见项目 README / 技能说明）。

### 3.6 前端（mail-guide-ai）

1. 配置 `mail-guide-ai-main/.env`（可参考 `.env.selfhosted.example`）：  
   - `VITE_SUPABASE_URL` = **机 1 Kong 对外基址**（HTTPS 就绪后为 `https://...`）。  
   - `VITE_SUPABASE_PUBLISHABLE_KEY` = 自建 `.env` 中的 `ANON_KEY`（或当前密钥体系下的 publishable key）。  
2. **构建期注入**：修改上述变量后必须 **重新执行** `docker compose build` / `npm run build`，再部署静态资源或容器。

### 3.7 HTTPS 与证书（与业务并行推进）

- 证书未就绪前仅适合 **内测**；**对外生产**建议在 **Kong、前端、Dify** 的对外入口均配置有效 TLS 后再切换流量，避免会话劫持与回调异常。  
- 官方 HTTPS 反代说明见 [Supabase Self-Hosted Proxy HTTPS](https://supabase.com/docs/guides/self-hosting/self-hosted-proxy-https)。

### 3.8 上线前最小验收

- Studio / Kong 可访问；`curl` 或等价请求 `/functions/v1/hello` 正常。  
- SQL：`cron.job` 四条齐全且 URL 正确；`vault.secrets` 含 `service_role_key`。  
- 前端：注册/登录、工作台打开无 CORS/跳转错误。  
- **Gmail**：在机 1 网络条件下完成「添加邮箱 → 测试连接 → 同步」抽样。  
- **网易**：同样抽样；若报 `UnknownIssuer`，记录域名与端口，转入 **第六节**。

---

## 四、用户注册与角色（与当前实现一致）

当前数据库触发器行为：**首个注册用户为 `admin`，之后新用户会自动获得 `agent` 角色**，并非「零角色、待管理员分配后才可用」。  
若产品要求改为「仅管理员分配角色后方可使用」，需 **另行** 数据库迁移与前端路由改造，**不在本文默认上线路径内**。

---

## 五、上线后事宜

### 5.1 日常运维

- **日志**：`docker compose logs` 关注 `kong`、`functions`、`db`；定时任务失败时核对 `cron.job` 与 vault 中 service role。  
- **发布**：  
  - 仅改函数源码 → `sync-functions-to-selfhost.ps1` + 重建 `functions`。  
  - 仅改 `.env.functions` → 重建 `functions`。  
  - 改迁移 → `db push`（仍建议临时端口流程，勿长期暴露 DB）。  
  - 改前端 `VITE_*` → **重新 build** 再发布。

### 5.2 备份与恢复

- **机 1 Postgres**：制定 **每日**（或更密）逻辑备份或卷快照，**保留 ≥ 30 天**；定期做 **恢复到测试环境** 演练，对照「≤4 小时」停机目标记录实际 RTO。  
- **现网 Dify 服务器**：其数据库与向量存储由 **现网备份策略** 覆盖；须保证与机 1 同等级别的 **保留周期（建议 ≥30 天）** 及恢复演练，否则仅恢复机 1 仍可能导致 AI 链路不可用。

### 5.3 密钥与依赖变更

- Dify Key、ERP 密码、邮箱密码、JWT 相关密钥轮换时，同步更新 `.env.functions` / `.env` 并按上述流程 **重建或重构建**。

### 5.4 容量与可选参数

- 大邮件同步体积上限见 [`DEPLOY.md`](../DEPLOY.md)「一」末尾与 `self-hosted-env-functions.example` 中 `MAIL_SYNC_FULL_BODY_*` 说明。

---

## 六、后续事宜：邮箱 CA 链 PEM

首轮上线 **不强制** 已具备 PEM；若 **网易**、**企业 TLS 代理** 或极少数场景下出现 **`invalid peer certificate: UnknownIssuer`**，按下述处理。

### 6.1 如何获取 PEM

1. **向服务商或 IT 索取（推荐）**  
   索取邮件服务器 **完整 TLS 证书链**（或签发/替换证书的 **企业根/中间 CA**），格式为 **PEM**（可含多段 `-----BEGIN CERTIFICATE-----` …）。

2. **使用 OpenSSL 抓取链**  
   在与生产 **出站一致** 的机器上执行（将主机与端口改为实际 IMAP/SMTP）：  
   ```bash
   openssl s_client -connect imap.example.com:993 -showcerts </dev/null 2>/dev/null
   ```  
   将输出中的多段证书合并为一个 `.pem` 文件（含服务器证书与中间 CA；若运行时仍报错再补根或咨询 IT）。

3. **经 HTTPS/TLS 解密代理**  
   使用浏览器或 IT 提供的 **代理根证书** 导出为 PEM，与对端链合并需谨慎：仅合并 **信任且必要** 的 CA，避免过大信任面。

4. **禁止用于生产的权宜之计**  
   `MAIL_LOCAL_TEST_MODE=true` 仅用于本地调试，**生产环境不得依赖**。

### 6.2 获取后的处理步骤

1. 将 PEM 文件保存到自建栈挂载目录，例如：  
   `supabase-selfhost/volumes/functions/certs/mail-ca.pem`  
   （与 [`self-hosted-supabase.md`](../mail-guide-ai-main/docs/self-hosted-supabase.md)「D3.1」一致。）

2. 在 **`supabase-selfhost/.env.functions`** 中增加：  
   `MAIL_TLS_CA_CERT_PATH=/home/deno/functions/certs/mail-ca.pem`  
   （若项目同时支持 `MAIL_TLS_CA_CERT_PEM` 内联，可按 `README` / example 选用其一。）

3. **确认生产关闭调试模式**：`MAIL_LOCAL_TEST_MODE` 未启用或为 `false`。

4. **重建 `functions` 容器**：  
   ```powershell
   cd <仓库根>\supabase-selfhost
   docker compose up -d --force-recreate --no-deps functions
   ```

5. **验证**：工作台「测试连接」与「立即同步」；`docker compose logs functions --tail 100` 无 `UnknownIssuer`。

### 6.3 建议节奏

- **Gmail**：多数情况默认信任库即可；若仍失败再按本节补链或排查代理。  
- **网易**：出现问题再针对该主机名拉链、配置 **单独 PEM**，避免将无关 CA 堆入同一文件，便于轮换与审计。

---

## 七、一页核对表（打印用）

| 序号 | 项 | 状态 |
|------|----|------|
| 1 | 现网 Dify：已导入本仓库工作流、固定域名 + HTTPS、Workflow URL/Key 可用且与 `.env.functions` 一致 | ☐ |
| 2 | 机 1 出站：Gmail IMAP/SMTP + 网易 + 现网 Dify HTTPS | ☐ |
| 3 | `supabase-selfhost` 启动健康，`.env` 对外 URL 正确 | ☐ |
| 4 | `db push` 完成且已去掉 db 临时宿主机端口 | ☐ |
| 5 | `Apply-VaultAndCron.ps1` 已执行，cron 4 条且无 `*.supabase.co` | ☐ |
| 6 | Functions 已同步，`.env.functions` 含 Dify + 正式 ERP | ☐ |
| 7 | 前端 `VITE_*` 指向生产 Kong，已重新 build 并部署 | ☐ |
| 8 | 抽样：Gmail/网易 测试连接与同步 | ☐ |
| 9 | Postgres（及 Dify 库）备份策略 ≥30 天 + 演练记录 | ☐ |
| 10 | 若出现 TLS 报错：按 **第六节** 配置 CA PEM 并重建 functions | ☐ |

---

*文档版本：与仓库路径 `docs/production-go-live.md` 同步维护。*
