# cs-main 生产上线准备与运维说明

本文档描述 **mail-guide-ai + 自建 Supabase（`supabase-selfhost`）+ Dify** 整体上线准备、上线后运维要点，以及 **邮箱 TLS / 自定义 CA**（第六节：何时需要 PEM、如何与当前函数实现配合）。**客户邮件自动处理**（订单关联、风控拦截、自动回邮）的统一规则与运维约定见 **第五节 5.5**（与代码实现迭代同步；业务说明见工作台 **帮助中心**）。
**不替代**下列原文档，细节命令与排错仍以原文为准：

| 文档 | 路径 |
|------|------|
| 新服务器 Docker **运维拉栈**（跑通前端 + 自建 Supabase；**不含**本仓 Dify 栈与本文内 `db push`） | [`docs/docker-deploy-new-server.md`](docker-deploy-new-server.md) |
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

1. 本地/首次全量迁移见 `self-hosted-supabase.md`：优先 **`docker compose cp` + `psql -f`**；`db push` 用本仓库 **`15432`**（非 `54323`），密码勿用占位符（`PGSSLMODE=disable` 等见原文档）。
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
   - **`DIFY_GATEWAY_API_KEY`**：由运维在本机生成强随机串写入（**非** Dify `app-` 密钥）；与 Dify 工作流输入 **`gateway_api_key`**、HTTP 头 **`x-api-key`** 为同一把钥匙。生成命令、重建 `functions` 与 **部署后密钥检查清单**（含 `gateway_api_key` 链路）见 [`docs/docker-deploy-new-server.md`](docker-deploy-new-server.md) **§四 步骤 5b** 与 **§六**。
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
- **密钥与 Dify 网关**：按 [`docker-deploy-new-server.md`](docker-deploy-new-server.md) **§六** 核对 `.env`、`.env.functions`、`gateway_api_key` 链路及前端 `VITE_*`。
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

### 5.5 客户邮件自动处理（统一规则与运维约定）

本节描述 **自动订单关联**、**自动风控拦截**、**自动回复客户邮件** 的统一产品行为，用于新绑定邮箱、同步大量历史邮件时**降低误操作**并保证时效；实现以 `process-email`、`risk-intercept`、订单/拦截补偿定时任务及配置开关为准，**与代码迭代同步修订**。业务侧说明见工作台 **帮助中心**（`business-user-guide.md`）。

#### 5.5.1 背景与目标

- **风险**：新绑定邮箱后若一次性同步大量旧邮件，自动关联/拦截/回邮可能对无关历史邮件**批量误处理**。
- **目标**：三类自动能力共用 **12 小时发件时间窗**（减轻历史邮件与定时扫描压力）；关联与拦截在逻辑上**先关联、再拦截**（关联失败仍可按邮件单号尝试拦截）；通过**可关闭的自动拦截总开关**、**有限重试**与**定时兜底**，将自动动作限制在「新、可识别、仍有时效」的邮件上；紧急处置仍依赖**人工**。

#### 5.5.2 统一时间窗（12 小时）

以下自动能力均以 **`emails.received_at`（邮件发件/解析时间）** 为准，相对**当前执行时刻**须在 **12 小时内**；超过 12 小时**不再**自动关联、自动拦截、自动回邮（人工操作不受此限，见 **5.5.9**）。

| 能力 | 12h 内 | 超过 12h | 发件时间缺失 |
|------|--------|----------|----------------|
| 自动关联订单 | 允许 | 不处理 | 保守视为不允许 |
| 自动拦截（开关开） | 允许 | 不处理、不补偿 | 保守视为不允许 |
| 自动回复客户 | 允许（另须模板/总开关等） | 不发送 | 保守视为不允许 |

实现参考：`process-email`（回邮）、`_shared/auto-risk-intercept-policy.ts`（`CUSTOMER_AUTOMATION_WINDOW_MS` 等）、`run-compensation-tasks` / `retry-risk-intercept-compensation`。**草稿生成**（`schedule-draft-generation`）仍为 **24h** 窗，与本节三类 **12h** 分离。

#### 5.5.3 统一处理流水线（关联 → 拦截）

对**取消订单 / 改地址**类意图（`order_cancel`、`address_change`），推荐在收信与定时兜底中共用同一顺序：

1. **准入**：12h 内、非 `manual_unlink`、有订单号或已关联等（见 **5.5.4**、**5.5.5**）。
2. **关联**：查本地 `orders` → 无则 OMS 查单 → 成功写 `email_order_links`；失败写/更新 `order_compensation_tasks`（**不阻塞**下一步）。
3. **拦截**（仅当自动拦截总开关为开）：已关联则按 `order_id`；未关联但有邮件单号则按 `order_no` 调 ERP hold；关联成功且需拦时**同轮**发起拦截。
4. **审计**：关联写入 `order_compensation_tasks`；拦截写入 `risk_intercept_logs`（含 ERP 响应、重试状态）。二者**可独立存在**（例如仅关联未拦、仅邮件单号拦、人工先关联后自动拦）。

**自动回复**仍在 `process-email` 既有分支处理，与上表共用 12h 窗，但不强制「先关联再回邮」。

#### 5.5.4 自动关联订单

| 项 | 约定 |
|----|------|
| **触发** | 收信 `process-email` 分析后**立即尝试一次**；近 12h 内「待关联」由定时任务**兜底**（见 **5.5.7**）。 |
| **条件** | AI/工作流解析出**有效订单号**；非人工解除关联；在 **12h** 窗内。 |
| **步骤** | 本地按单号匹配 → 无则 OMS（发件人邮箱 + 单号）→ 仍无则 `order_compensation_tasks` 待重试。 |
| **与拦截开关** | **无关**：总开关关闭时**仍**自动查单、关联。 |
| **重试** | 定时兜底扫描；单邮件有**最小间隔**与 **12h 内最大次数**上限（实现可配置；目标架构见 **5.5.7**）。 |
| **成功** | `association_status` 趋于 `linked`，写 `email_order_links`。 |

#### 5.5.5 自动风控拦截与总开关

**总开关**（`automation_settings.risk_auto_intercept_enabled`，管理员在 **拦截记录** 页配置，默认建议 **关**）：

| 项 | 约定 |
|----|------|
| **开** | 允许自动 ERP hold；失败进入 `risk_intercept_logs` 补偿队列。 |
| **关** | **不**自动拦截、**不**继续自动补偿；**仍**执行自动关联（**5.5.4**）。 |
| **人工** | 工作台「暂停发货 / 恢复发货」**不受**开关与 12h 限制（见 **5.5.9**）。 |

**自动拦截准入**（须同时满足，与开关无关的条目仍须满足）：

1. 意图为 **取消订单** 或 **改地址**。
2. **12h** 发件时间窗内；`received_at` 不可解析则**不拦**。
3. **已关联本地订单**，或工作流已提供**邮件单号**（未关联无单号 → **不自动拦**）。
4. 非 `manual_unlink`。
5. 总开关为 **开**。

**解除拦截**：本系统不向 ERP 发 release；运营在 **迅捷 ERP** 操作；工作台 release 仅同步本地展示。

#### 5.5.6 自动回复客户邮件

| 项 | 约定 |
|----|------|
| **时间窗** | 与上：**12h** 内 `received_at`（`CUSTOMER_AUTOMATION_WINDOW_MS`）。 |
| **其它** | 模板 `auto_send`、意图勾选、首封/冷却、缺单号与缺附件等规则见 `customer-service-automation-spec.md` §6；**12h 与模板规则同时生效，取更严者**。 |
| **与关联/拦截** | 并行；不要求先关联再回邮。 |

#### 5.5.7 触发节奏与定时兜底

| 入口 | 行为 |
|------|------|
| **收信** | `sync-mailbox` 入库后异步 `process-email`：**完整跑一遍**（分析、关联、拦截、自动回邮等分支）。 |
| **定时兜底** | 扫描近 **12h** 内仍「待关联 / 待拦截 / 任务到期」的邮件，执行与收信相同的关联→拦截顺序；建议周期 **每 20 分钟** 一轮，单轮**处理条数上限**与单邮件**最短间隔**可配置，避免瞬时打满 OMS/ERP。 |

**Phase A 现行实现（以 `Apply-VaultAndCron.ps1` 为准）**

- 收信：`process-email`（分析、关联、拦截、自动回邮）。
- 订单关联补偿：`run-compensation-tasks`，cron **`*/20 * * * *`**（job 名 `run-compensation-tasks-every-30min` 为历史遗留）。
- 拦截补偿：`retry-risk-intercept-compensation`，cron **`*/20 * * * *`**（job 名 `retry-risk-intercept-hourly-at-45` 为历史遗留）。
- **补偿间隔**：`next_run_at` / `next_compensation_at` 步长 **20 分钟**（`COMPENSATION_STEP_MS`）。
- **补偿次数**：收信 **1 次** + 补偿 **最多 20 次**（`MAX_COMPENSATION_ATTEMPTS`）；关联任务 `max_retries` 默认 **20**。
- **retrying 终态**：补偿 **20 次用尽**、邮件 **超 12h**（`[policy:stale_email]`）、无 email/订单引用、开关关闭等 → `failed`（不设单独 retrying 挂起时长上限；`retrying_started_at` 仅作审计）。

**后续可选（Phase B）**：合并为单一 `sweep-order-actions` cron，替代上述两条补偿 job。

#### 5.5.8 限流与审计

| 项 | 约定 |
|----|------|
| **限流** | 定时兜底每轮 LIMIT（建议 **40～60** 封，按日均约 1000～2000 封可调）；单邮件 `last_order_action_at` 冷却（建议 **≥20 分钟**）。 |
| **审计表** | **`order_compensation_tasks`**：关联重试；**`risk_intercept_logs`**：拦截与 ERP 结果。允许「只关联不拦」「只拦未关联（邮件单号）」「人工关联 + 自动拦」等组合。 |
| **幂等** | 拦截按 `idempotency_key` upsert；已成功 `hold` 不重复打 ERP。 |

#### 5.5.9 人工不受限范围

- **自动拦截总开关**：不限制人工拦截。
- **12 小时**：人工在工作台发起的拦截/解除、查单关联**不受**发件 12h 限制（以培训与 ERP 规则为准）。

#### 5.5.10 开关关闭时的终态（进行中拦截）

- 开关由开改为关：**不再**跑满剩余自动补偿。
- 对 `risk_intercept_logs` 中 `retrying` 且可补偿行：下一轮兜底标 **failed**，`error_message` 建议含 `[policy:disabled]`，与自然用尽区分。

#### 5.5.11 运营告警（首次 / 末次邮件）

自动**关联**与自动**拦截**失败时，各向运营收件人发送 **最多两封**邮件（写入 `ops_alerts`，独立 `idempotency_key` 去重）：

| 链路 | 首次（`kind`） | 末次（`kind`） |
|------|----------------|----------------|
| 自动拦截 | `auto_failed_first`：首次 ERP/流程失败进入 `retrying` 或 `process-email` 调 `risk-intercept` HTTP 失败 | `auto_failed_final`：补偿 20 次用尽、超 12h、开关关闭等终态 `failed` |
| 自动关联 | `auto_association_first`：收信查单未命中且已创建 `order_compensation_tasks` | `auto_association_final`：补偿 20 次仍无订单、`manual_unlink`、超 12h 停止等 |

- 标题含 **`[首次]`** / **`[末次]`** 便于运营告警页区分。
- **已取消**原 `schedule-compensating-alerts` 的 **2h compensating 定时提醒**（`compensating-alerts-every-30min` cron 由部署脚本 `unschedule`）。
- 人工拦截失败仍走原 `kind: failed` 单次告警。

实现：`_shared/ops-notify.ts`、`_shared/automation-alert-keys.ts`、`automation-intercept-alerts.ts`、`automation-association-alerts.ts`。

#### 5.5.12 运维与上线核对

- **开关**：`automation_settings.risk_auto_intercept_enabled` 默认值、管理员权限、拦截记录页 UI。
- **Cron**：`SELECT jobname, schedule, command FROM cron.job;` — URL 指向本栈 Kong，无 `*.supabase.co`；**无** `compensating-alerts-every-30min`；`run-compensation-tasks-every-30min` 与 `retry-risk-intercept-hourly-at-45` 的 `schedule` 均为 **`*/20 * * * *`**（部署后须执行 `Apply-VaultAndCron.ps1`）。
- **迁移**：`20260520120000_automation_12h_twenty_compensation_retries.sql`（补偿次数上限 20）。
- **12h 抽样**：无单号、超 12h、`manual_unlink` 邮件**无**自动拦截；开关关时**仍可有**关联任务、**无**新 hold。
- **告警抽样**：自动拦截首次失败 → `ops_alerts.auto_failed_first` 且 `email_sent_at` 非空；用尽补偿 → 另有 `auto_failed_final` 且再发一封；关联同理 `auto_association_first` / `auto_association_final`。
- **帮助中心**：`business-user-guide.md` 与本文 **5.5** 口径一致（12h、先关联再拦、开关仅控拦截、首次/末次运营邮件）。

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
| 11 | **客户邮件自动处理**（见 **5.5**）：12h 窗与 20min/20 次补偿已部署；`Apply-VaultAndCron` 已跑；抽样无单号/超 12h 不误拦、关开关仍可关联 | ☐ |

---

*文档版本：与仓库路径 `docs/production-go-live.md` 同步维护。*
