# cs-main 生产上线准备与运维说明

本文档描述 **mail-guide-ai + 自建 Supabase（`supabase-selfhost`）+ Dify** 整体上线准备、上线后运维要点，以及 **邮箱 TLS / 自定义 CA**（第六节：何时需要 PEM、如何与当前函数实现配合）。**自动风控拦截**的产品规则与运维约定见 **第五节 5.5**（与代码实现迭代同步）。  
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
- **邮箱**：同时使用 **网易** 与 **Gmail 企业邮箱**。`imap.163.com` 所用 **TecSign** 链已在函数 `_shared/mail-tls-ca.ts` 内置兜底，首轮上线 **不强制** 单独准备 PEM；Gmail 等公共 CA 一般亦无需 PEM。若遇 **`UnknownIssuer`**、企业代理根、或非 163 的私有 CA，仍按 **第六节** 处理。
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

- 确认 `cron.job` 中存在 **5 条**业务任务，且 **`command` 中不得出现 `*.supabase.co`**（应指向本栈 Kong，如 `http://kong:8000/functions/v1/...`）。  
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
- SQL：`cron.job` 五条齐全且 URL 正确；`vault.secrets` 含 `service_role_key`。  
- 前端：注册/登录、工作台打开无 CORS/跳转错误。  
- **Gmail**：在机 1 网络条件下完成「添加邮箱 → 测试连接 → 同步」抽样。  
- **网易**：同样抽样；若仍报 `UnknownIssuer`（例如证书链轮换后内置兜底未更新），记录域名与端口，转入 **第六节**。

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

### 5.5 自动风控拦截（产品规则与运维约定）

本节描述 **自动** 风控拦截与补偿的**目标行为**，用于新账号绑定邮箱、同步大量历史邮件时**降低批量误拦截**风险；实现以 `risk-intercept`、`process-email`、定时任务及配置开关为准，**与代码迭代同步修订**。

#### 5.5.1 背景与目标

- **风险**：新绑定邮箱后若一次性同步大量旧邮件，自动拦截可能对无关历史邮件**批量误拦**。
- **目标**：通过**可关闭的自动拦截**、**严格的准入条件**、**有限次数的补偿重试**与**发件时间窗口**，将自动动作限制在「新、可识别、仍有时效」的邮件上；紧急处置仍依赖**人工**。

#### 5.5.2 总开关（仅约束自动）

| 项 | 约定 |
|----|------|
| **开** | 允许在邮件处理链路中执行**自动拦截**，并在失败时进入**自动补偿**调度。 |
| **关** | **不**执行自动拦截，**不**继续执行自动补偿；避免环境或策略原因下的误操作扩大。 |
| **人工** | **不受开关约束**：工作台人工「暂停发货 / 恢复发货」等拦截类操作**始终可用**（见 5.5.5）。 |

#### 5.5.3 自动拦截与补偿节奏

| 项 | 约定 |
|----|------|
| **收信触发** | 在开关为**开**且满足 **5.5.4** 准入条件时，对同一封邮件的自动拦截在收信处理链路中**最多尝试 1 次**。 |
| **补偿** | 若该次自动拦截**未成功**（需进入待补偿/重试类状态），则再执行**最多 3 次**自动补偿；**同一记录两次补偿尝试之间间隔不少于 1 小时**（按「上次尝试时间 + 1 小时」等字段控制，避免同一小时内重复打 ERP）。 |
| **终态** | **收信 1 次 + 补偿 3 次**仍不成功 → 记为**拦截失败**（与 `risk_intercept_logs` 等业务终态对齐，具体字段名以实现为准）。 |
| **成功** | 任意一次（收信或第 1～3 次补偿）成功 → 成功终态，**不再**排后续补偿。 |
| **超长「重试中」** | 每次**补偿任务**执行时，若记录仍处于自动补偿的「重试中」状态且**自进入该状态起已超过 4 小时**，则记为**拦截失败**（错误信息中带 `[policy:retrying_timeout_4h]`），避免队列永久卡住。计时以 `retrying_started_at` 为准，缺失时回退 **`created_at`**（不得用 `updated_at`：补偿失败落库会刷新该行 `updated_at`，否则 4 小时条件永远不成立）。 |

**调度（cron）**：补偿任务在**每小时的第 45 分钟**执行一轮（例如 **09:45、10:45、11:45**），与业务时区一致；每轮仅处理「已到下次执行时间」且仍未成功、未用尽次数的记录。

#### 5.5.4 自动拦截准入（须同时考虑）

以下不满足时，**不进行自动拦截**，且**不进入自动补偿队列**（与开关状态无关，属准入逻辑）：

1. **未关联本地订单**且**工作流判定邮件未提供订单号** → **不自动拦截**（避免无单号历史邮件被批量处理）。  
   - 未关联但工作流**已提供**订单号时，仍可按产品允许走「凭邮件单号」等自动路径（若实现支持）。

2. **发件时间**：以邮件头中的发送时间为准，若相对**当前执行时刻**已超过 **24 小时**，则**不自动拦截**、不参与自动补偿。  
   - **发件时间不可解析**时，建议按**保守策略**处理（例如视为超窗或视为不满足自动拦截条件），并在需求/实现说明中写死一种，避免误拦。

#### 5.5.5 人工不受限范围

- **开关**：人工拦截**不受**自动拦截总开关限制。  
- **24 小时**：人工在工作台发起的拦截/解除**不受**「发件时间超过 24 小时」限制。

#### 5.5.6 开关关闭时的终态（进行中记录）

- 开关由开改为关后：**不再继续**跑满剩余自动补偿次数。  
- 对**已因自动拦截进入待补偿/重试中**的记录，须在合理时限内将**自动链路**相关终态更新为**拦截失败**（或等价失败态），并建议通过**错误原因/元数据**区分「自然用尽失败」与「策略关停（开关关闭）终止」，便于审计与客服解释。

#### 5.5.7 运维与上线核对（实现落地后）

- 确认**开关**在 **拦截记录**页由管理员配置（`automation_settings.risk_auto_intercept_enabled`）、默认值及权限。
- 确认 **pg_cron / 自建 cron** 中补偿任务为**每小时 `:45`** 触发，且任务 URL 指向本栈 Kong（与 **3.4** 一致，不得误用 `*.supabase.co`）。  
- 新账号绑定后抽样：大量**无单号且未关联**、或**发件时间早于 24 小时**的邮件应**无自动拦截调用**；人工仍可对指定邮件操作拦截。

---

## 六、邮箱 TLS 与自定义 CA（与当前实现一致）

Edge Functions 里 IMAP/SMTP 使用 Deno 原生 `connectTls` / STARTTLS，通过 `_shared/mail-tls-ca.ts` 组装 **`caCerts`（额外信任的 PEM 段）**。逻辑顺序为：

1. `MAIL_TLS_CA_CERT_PEM`（内联 PEM，可选）  
2. `MAIL_TLS_CA_CERT_PATH` 或 `DENO_CERT` 指向的文件（可选；**User Worker 沙箱内读宿主机挂载路径可能失败**，见下）  
3. 依次尝试读取默认路径 `../certs/mail-ca.pem`（相对 `_shared`）与绝对路径 `/home/deno/functions/certs/mail-ca.pem`  
4. 仍无可用材料时，使用代码内 **`BUNDLED_163_MAIL_CA_PEM`**（当前为 **163 `imap.163.com` / TecSign** 叶子 + 根）

因此：**首轮上线不必为 163 单独准备 PEM**；若日志出现 `parsed 2 certificate(s) from bundled 163 mail CA`，说明 163 兜底已参与校验。其他邮箱、代理或私有 CA 仍可按本节补链。

### 6.1 何时需要额外 PEM（决策）

| 场景 | 是否通常要配 `MAIL_TLS_CA_CERT_*` / `certs/mail-ca.pem` |
|------|--------------------------------------------------------|
| **Gmail**（`imap.gmail.com` / `smtp.gmail.com`） | **否**，公共 PKI 一般足够；出口 **TLS 解密代理** 导致 `UnknownIssuer` 时 **是**（用代理根或 IT 提供的链） |
| **163 个人邮**（`*.163.com` TecSign） | **否**（内置兜底）；网易 **更换证书链** 后若仍 `UnknownIssuer`，**是**（更新内置常量或 PEM，见 6.4） |
| **企业邮 / 自建 IMAP / 其他 CA** | **视情况**，出现 `UnknownIssuer` 即按 6.2 准备 PEM |
| **仅开发联调** | 可临时 `MAIL_LOCAL_TEST_MODE=true`（明文 IMAP，**禁止生产**） |

### 6.2 如何获取 PEM（需要时）

1. **向服务商或 IT 索取（推荐）**  
   索取 **完整 TLS 链** 或签发该服务器证书的 **根/中间 CA**，格式为 **PEM**（可含多段 `-----BEGIN CERTIFICATE-----` …）。

2. **使用 OpenSSL 抓取链**  
   在与生产 **出站一致** 的环境执行（主机与端口改为实际 IMAP/SMTP）：  
   ```bash
   openssl s_client -connect imap.example.com:993 -showcerts </dev/null 2>/dev/null
   ```  
   将输出中的多段证书合并为一个 `.pem`（通常含服务器证书 + 中间 CA；仍报错再补根或咨询 IT）。  
   Windows 若无本地 `openssl`，可用仓库内已用过的方式：在 **能访问目标邮箱** 的机器上导出链，或临时用 **Docker + Alpine + openssl** 拉取后再保存为 PEM。

3. **经 TLS 解密代理**  
   仅合并 **代理根 / 企业信任锚** 与 **邮箱链** 中 **必要** 的 PEM，避免盲目扩大信任面。

4. **禁止用于生产的权宜之计**  
   `MAIL_LOCAL_TEST_MODE=true` 仅用于本地调试，**生产不得依赖**。

### 6.3 放入仓库并同步到自建（推荐路径）

**推荐把 PEM 放进源码树**，由 `sync-functions-to-selfhost.ps1` 一并复制到 `supabase-selfhost/volumes/functions/`，避免只改挂载卷而漏同步：

1. 保存为：  
   `mail-guide-ai-main/supabase/functions/certs/mail-ca.pem`  
   （与 [`self-hosted-supabase.md`](../mail-guide-ai-main/docs/self-hosted-supabase.md)「D3.1」、[`DEPLOY.md`](../DEPLOY.md) 描述一致；同步后出现在 `supabase-selfhost/volumes/functions/certs/mail-ca.pem`。）

2. 在 **`supabase-selfhost/.env.functions`** 中保留（推荐）：  
   `MAIL_TLS_CA_CERT_PATH=/home/deno/functions/certs/mail-ca.pem`  
   或使用 `MAIL_TLS_CA_CERT_PEM` 内联（见 `self-hosted-env-functions.example`）。  
   说明：部分环境下 User Worker **读不到**上述路径文件时，函数仍会尝试 **内置 163 链** 或其它已加载的 PEM；保留环境变量有利于 **非 163** 邮箱与后续轮换。

3. **确认生产关闭调试模式**：`MAIL_LOCAL_TEST_MODE` 未启用或为 `false`。

4. **同步并重建 `functions`**（自建 **不需要** `npx supabase functions deploy`）：  
   ```powershell
   cd <仓库根>\mail-guide-ai-main\scripts
   .\sync-functions-to-selfhost.ps1

   cd <仓库根>\supabase-selfhost
   docker compose up -d --force-recreate --no-deps functions
   ```

### 6.4 验证、日志与 163 兜底维护

1. 工作台执行 **「测试连接」** 与 **「立即同步」**。  
2. `docker compose logs functions --tail 100`：应无持续 `UnknownIssuer`。  
3. **163**：若见 `parsed 2 certificate(s) from bundled 163 mail CA`，说明内置兜底在起作用。  
4. **证书轮换后**：若 163 更换链导致再次 `UnknownIssuer`，需更新 **`mail-guide-ai-main/supabase/functions/_shared/mail-tls-ca.ts`** 中的 `BUNDLED_163_MAIL_CA_PEM`，并/或更新 **`certs/mail-ca.pem`**，再执行 **6.3 第 4 步**。

### 6.5 与「仅重建容器」的关系

仅修改 `supabase-selfhost/volumes/functions/` 下文件而不跑 **`sync-functions-to-selfhost.ps1`**，容易与 `mail-guide-ai-main/supabase/functions/` **漂移**；生产变更应以 **源码树 + 同步脚本** 为准，与 [`DEPLOY.md`](../DEPLOY.md)「一」一致。

---

## 七、一页核对表（打印用）

| 序号 | 项 | 状态 |
|------|----|------|
| 1 | 现网 Dify：已导入本仓库工作流、固定域名 + HTTPS、Workflow URL/Key 可用且与 `.env.functions` 一致 | ☐ |
| 2 | 机 1 出站：Gmail IMAP/SMTP + 网易 + 现网 Dify HTTPS | ☐ |
| 3 | `supabase-selfhost` 启动健康，`.env` 对外 URL 正确 | ☐ |
| 4 | `db push` 完成且已去掉 db 临时宿主机端口 | ☐ |
| 5 | `Apply-VaultAndCron.ps1` 已执行，cron 5 条且无 `*.supabase.co` | ☐ |
| 6 | Functions 已同步，`.env.functions` 含 Dify + 正式 ERP | ☐ |
| 7 | 前端 `VITE_*` 指向生产 Kong，已重新 build 并部署 | ☐ |
| 8 | 抽样：Gmail/网易 测试连接与同步 | ☐ |
| 9 | Postgres（及 Dify 库）备份策略 ≥30 天 + 演练记录 | ☐ |
| 10 | 若出现 TLS 报错：按 **第六节** 决策是否补 PEM；163 可先查日志是否已 `bundled 163 mail CA`，再决定是否更新内置链或 `certs/mail-ca.pem` 并同步重建 functions | ☐ |
| 11 | **自动风控拦截**（见 **5.5**）：开关默认值与权限、补偿 cron（每小时 `:45`）、抽样验证无单号/超 24h 邮件不误拦；关停后进行中记录终态策略已确认 | ☐ |

---

*文档版本：与仓库路径 `docs/production-go-live.md` 同步维护。*
