# 客服自动化与邮件处理方案（完整版）

本文档汇总 **收信 → 同步 → 分析 → 分流 → 自动回复 / 内部预警 → 草稿** 的产品口径与实现约束，作为开发与验收依据。  
**现状代码可能尚未完全实现本文档**；以本文档为目标态，改造时逐项对齐。

---

## 0. 产品决策摘要（2026-05-10）

以下条款为**已确认**口径，与历史 PRD/实现冲突时以本节为准：

| 主题 | 决策 |
|------|------|
| 工单完成态 | **仅保留「已回复」**（`replied`）。产品流程不区分 `closed`；数据库若仍保留 `closed` 列/约束仅为兼容历史数据，**不作为主流程状态**。 |
| 自动草稿时间窗 | **收信满 1h 后**参与调度：**1h～6h** Dify 长稿，**6h～24h** 本地短稿；≥24h 不自动。 |
| `not_provided`（未提供单号） | **不**发内部运营预警邮件。 |
| `compensating` 内部预警 | 收信 **≥2h** 且 **≤72h** 内才允许首次内部预警；**超过 72h** 的邮件**不再**因 compensating 发预警。 |
| 自动回复开关 | **长期放在 Supabase Functions secrets**（如 `AUTO_REPLY_*`），不设管理员 UI 配置表（本期）。 |
| 告警邮件 | **固定发件人**：在 `mailboxes` 中配置与 `ALERT_SENDER_ADDRESS`（或 `ops-notify` 默认值）一致的 SMTP；收件以 env 为准（如 `ALERT_EMAIL_TO`）。 |
| Shopify | **不继续**：`risk-intercept` **不调用** Shopify API，仅更新本地 `orders` hold；与 ERP 的拦截以 `docs/erp-api-requirements.md` 为准。 |
| 订单补偿任务 | **最多重试 10 次**；**每 30 分钟**调度一次重试（`next_run_at` 步长 30 分钟）。 |
| 运营告警页文案 | 告警 `resolved` 状态对用户展示为 **「已处理」**（与邮件 `replied` 语义区分）。 |
| 订单解除拦截 | **由 ERP 端操作**，本系统不向 ERP 发送 release 指令。`risk-intercept` release 仅将本地 `orders.shipping_hold` 置回 `false` 以同步前端展示状态，不调用任何外部接口。运营人员须在 ERP 后台手动解除拦截。 |
| **自动风控拦截** | 总开关由前端 **拦截记录**页（管理员）配置 `automation_settings.risk_auto_intercept_enabled`；准入、补偿与人工例外见 **§6.4**；上线运维与 cron 另见仓库根目录 [`docs/production-go-live.md`](../../docs/production-go-live.md) **§5.5**。 |
| **发布环境** | **生产为自建 Supabase（Docker）**；**业务逻辑仍在 Supabase Edge Functions（Deno）** 中运行，与 Cloud 项目共用同一套 `mail-guide-ai-main/supabase/functions/` 源码，仅部署与网关 URL 不同。cron URL 须指向自建 Kong 的 `/functions/v1/...`，**不得**固定写 `*.supabase.co`（详见 `docs/self-hosted-supabase.md`）。 |

---

## 1. 总体链路

```
收到邮件 → IMAP 同步（sync-mailbox）→ 入库
       → 异步触发 process-email（邮件分析 + 分流）
       → 可选：客户自动回复 / 风控拦截 / 内部预警 / 进入草稿调度
       → schedule-draft-generation（每 30 分钟）：符合条件的邮件自动生成草稿
       → 人工可随时本地生成草稿（generate-draft）
```

- **分析引擎**：配置 `DIFY_ANALYZE_URL` / `DIFY_ANALYZE_KEY` 时走 **Dify 工作流**（如 `dify-workflows/email-analysis.yml`）；否则或调用失败时走 **本地规则分析**。

---

## 2. 邮件分析输出（目标字段）

分析结果需支撑后续分流与草稿，**至少包含**：

| 字段 | 说明 |
|------|------|
| 意图 | `intent`（legacy）+ `business_intent`（7 类枚举，唯一业务口径） |
| 订单号 | 从正文/主题提取或模型输出，用于关联 `orders` |
| 语言 | `ai_language`（落库）；识别异常时 **默认 `en`** |
| 情绪 | `ai_sentiment`（落库）；识别异常时建议默认 `neutral`（可与产品再定） |
| 信息是否完整 | `is_info_complete` |
| 缺失信息 | `missing_elements`（如 `order_no`、`image`） |
| 内容摘要 | `ai_summary` |
| 其它 | `priority`、`risk_level`、`category`、`entities` 等按现有模型保留 |

**落库要求**：`ai_language`、`ai_sentiment` **必须持久化**（建议 `emails` 独立列），供 **自动/人工草稿** 按语种与语气生成。

---

## 3. 订单关联与状态语义

- **已关联**：`email_order_links` 存在且对应 `orders` 有记录 → `association_status = linked`。
- **有单号未匹配**：客户提供了订单号，本地库暂无对应订单 → 写入 **补偿任务**（`order_compensation_tasks`），`association_status = compensating`。
- **未提供单号**：无可用订单号 → `not_provided`（或等价语义）。

**补偿任务参数（已确认）**：

- 默认 **`max_retries = 10`**。
- 每次未查到订单时，**`next_run_at` 推迟 30 分钟**（与 pg_cron 调用周期建议一致，例如每 30 分钟执行一次 `run-compensation-tasks`）。

关联成功后，后续拦截、草稿等逻辑依赖 **linkedOrders.length > 0**。

---

## 4. 两套时间线（客户自动回复 vs 内部预警）

二者 **独立**，需同时判断：

| 类型 | 时间条件 | 用途 |
|------|----------|------|
| **客户自动回复** | `now - received_at ≤ 24h` | 仅在此窗口内给客户发自动模板；**超过 24h 一律不发**。 |
| **内部预警（compensating）** | `2h ≤ now - received_at ≤ 72h` | 有单号未关联成功时，**首次**内部预警不早于收信后 **2h**，且**不晚于**收信后 **72h 仍持续预警**（超过 72h 不再发此类预警）。需 **去重**。 |

**说明**：

- 客户 24h 与内部 2h～72h **互不替代**。例如收信 3h、仍 compensating：可发内部预警；若已超过 24h，仍 **不对客户** 自动回复。
- **`not_provided`**：**不**走内部 compensating 预警（无单号场景不发运营预警邮件）。
- **取消/改地址** 且邮件 **已超过 24h**：**禁止**对客户自动回复（即使开关打开）。

---

## 5. 开关与通用自动回复逻辑

### 5.1 开关（配置方式已确认）

| 配置 | 作用 | 存放 |
|------|------|------|
| **总开关**（`AUTO_REPLY_CUSTOMER_ENABLED`） | 关闭时，**所有**给客户自动模板 **一律不发**。 | Supabase Functions **secrets** |

### 5.2 客户自动回复通用前置条件

在 **各业务分支** 条件满足时，发送前 **必须** 同时满足：

1. **总开关** 打开；  
2. **`received_at` 距今 ≤ 24h**；  
3. 模板存在、后台 **自动回复**（`auto_send`）已打开、当前 `business_intent` 在该模板的 `enabled_business_intents` 内、冷却与去重逻辑正常（`process-email` 的 `sendAutoReplyBySlot`；`is_active` 仅与 `auto_send` 同步写入，发信不单独判断）。

不满足任一项 → **跳过发送**，建议写处理事件（如 `auto_reply_skipped_*`）便于排查。

---

## 6. 按意图分流（目标行为）

### 6.1 取消订单（`order_cancel`）或 改地址（`address_change`）

| 条件 | 客户自动回复 | 订单/风控 | 内部预警 |
|------|----------------|-----------|----------|
| **未提供订单号**（无法关联） | 总开关开 **且** ≤24h **且** 槽一模板（`ar_missing_order`）`auto_send` 与意图勾选满足：发索要单号等模板；否则不发 | **不**调用拦截 | **不**发内部预警（已确认） |
| **有单号且关联成功** | 一般不先发「缺单号」模板 | **调用** `risk-intercept`（本地 hold；**不**调 Shopify） | 拦截失败时现有告警机制 |
| **有单号但未关联成功**（compensating） | **不对客户**发「缺单号」模板 | **不**拦截（直至关联成功） | **2h～72h** 窗口内发 **内部预警**（去重）；**超过 72h** 不再预警 |

**特别强调**：**超过 24h** 的取消/改地址邮件 **不**对客户自动回复（即使开关打开）。

### 6.2 破损（`damaged`）、缺陷（`defect`）、描述不符（`description_mismatch`）

| 条件 | 行为 |
|------|------|
| **可配置首封窗口**（每条双槽模板 `reply_templates.auto_reply_first_contact_days`：0=不限，3/7/15/30 天；**按实际触发的槽**各自校验；同发件人在该窗口内无其它邮件）+ **信息不完整**（缺单号或缺附件等，与 `missing_elements` 一致） | 命中自动模板回复时，仍须满足 **§5.2 通用条件**（含 ≤24h、总开关） |
| 非首封或信息完整 | 按现有逻辑进入人工或其它分支，**不**强行自动回复 |

（「首封」口径：`process-email` 按**当前槽位模板**配置的天数查询同发件人近期邮件；天数为 0 时不做首封校验。`emails.is_first_email` 展示字段取双槽非 0 天数的**较大值**统计。管理端在「回复模板」每条卡片内配置。）

**双槽自动回邮（实现摘要）**：`reply_templates` 固定两条——`ar_missing_order`（缺单号）、`ar_missing_order_or_attachment`（缺单号或附件）。每条含 `enabled_business_intents`（后台勾选）。R1 场景（`order_cancel` / `address_change` / `logistics` + 无单号 + 无关联）走槽一；R2 场景（`damaged` / `defect` / `description_mismatch` + 缺单号或缺任意附件）走槽二。两槽与 R1/R2 一致，**仅**受总开关、`auto_send`、首封窗口等约束，**无**单独的 Functions 环境变量门闸。历史多 `trigger_type` 模板已由迁移关闭 `auto_send`。

### 6.3 其它意图

按现有分类、优先级、SLA 桶等继续处理；自动回复仅在产品定义的分支内启用。

### 6.4 自动风控拦截（开关、准入、补偿与人工例外）

> **目的**：新绑定邮箱、同步大量历史邮件时，降低**批量误拦截**；与 `risk-intercept`、`process-email`、`risk_intercept_logs` 及定时任务实现**逐项对齐**。运维侧一页说明见仓库根目录 [`docs/production-go-live.md`](../../docs/production-go-live.md) **§5.5**。

#### 6.4.1 总开关（仅约束自动）

| 项 | 约定 |
|----|------|
| **开** | 允许在邮件处理链路中执行**自动拦截**，失败时可进入**自动补偿**调度。 |
| **关** | **不**执行自动拦截，**不**继续执行自动补偿。 |
| **人工** | **不受开关约束**：工作台人工暂停/恢复发货（调用 `risk-intercept`）**始终可用**。 |

（开关配置形态以实现为准，例如 automation 配置表或 Functions secrets；需与 §0 其它开关的运维方式协调。）

#### 6.4.2 自动尝试节奏与调度

| 项 | 约定 |
|----|------|
| **收信** | 开关为开且满足 **6.4.3** 时，对同一封邮件在 `process-email` 链路中**最多自动尝试 1 次**拦截。 |
| **补偿** | 若该次未成功（进入待补偿/重试类状态），再**最多 3 次**自动补偿；**同一 `risk_intercept_logs`（或等价记录）两次补偿之间间隔不少于 1 小时**（由 `next_compensation_at` 或等价字段控制）。 |
| **终态** | **收信 1 次 + 补偿 3 次**仍不成功 → **拦截失败**（与 `risk_intercept_logs.status` 等对齐）。 |
| **成功** | 任意一次成功 → 成功终态，不再排补偿。 |
| **Cron** | 补偿扫描在**每小时的第 45 分钟**执行（如 09:45、10:45）；每轮只处理「已到点」且未用尽次数的记录。 |

#### 6.4.3 自动拦截准入（不满足则不拦、不排补偿）

1. **未关联本地订单**且**工作流判定未提供订单号** → **不自动拦截**（与 §6.1「未提供订单号不调用拦截」一致方向；未关联但**已**提供单号时，可按实现走凭邮件单号等路径）。  
2. **发件时间**：以邮件头发送时间为准，相对**当前执行时刻**已超过 **24 小时** → **不自动拦截**、**不**进入自动补偿。  
   - **发件时间不可解析**：须在实现中约定一种**保守**策略（建议倾向不自动拦截），并在迁移/代码注释中写死。

#### 6.4.4 人工不受限

- **开关**、**24 小时发件时间**均**不**限制人工在工作台发起的拦截/解除。

#### 6.4.5 开关关闭时的终态

- 开关关闭后：**不再**跑满剩余自动补偿。  
- 对已进入待补偿/重试中的自动拦截记录，须在合理时限内将终态更新为**拦截失败**（或等价），并建议用元数据区分「用尽失败」与「策略关停」，便于审计。

---

## 7. 内部预警（有单号未关联）

- **触发**：`association_status = compensating`，且存在有效 `order_no`（任务或实体字段）。  
- **时间**：**收信满 2 小时** 且 **未满 72 小时**（`received_at` 距今在 \((2h, 72h]\) 区间内）才允许 **首次**内部预警邮件。  
- **实现**：`process-email` 当下若不足 2h，只落库/事件，**不发**预警；由 **`schedule-compensating-alerts`**（建议每 30min cron）扫描满足条件的邮件再发送。  
- **去重**：同一 `email_id` + 同类预警类型只发一次（`ops_alerts.idempotency_key`）。

预警内容至少建议包含：`email_id`、客户邮箱、主题/摘要、`order_no`、`business_intent`、关联状态。

---

## 8. 自动生成草稿

| 项 | 口径 |
|----|------|
| **调度** | 每 **30 分钟**（pg_cron 调 `schedule-draft-generation`） |
| **邮件状态** | `pending` 或 `processing` |
| **草稿** | 当前无非空草稿（`ai_drafts` 无有效 `draft_content`） |
| **收信时间** | `received_at` 在 **24 小时内** |
| **最早生成时间** | 收信后 **满 1 小时** 才参与调度（避免刚入库反复调用） |
| **通道** | **1h～6h**：Dify 长草稿；**6h～24h**：本地短稿 |
| **候选范围** | **不排除**：未关联订单、曾走拦截分支等 **只要仍满足** `status` + 时间 + 无草稿 + 龄≥1h **即参与**；若代码中拦截会改 `status` 导致选不中，需 **调整状态机或查询条件** 以符合本条款 |

---

## 9. 人工生成草稿

- **随时**可触发（需登录）。  
- **仅本地短稿**（`buildLocalDraft`），**不**走 Dify；`mode` 非 `local` 应拒绝。  
- 生成时应可读 `emails.ai_summary`、`ai_language`、`ai_sentiment` 以统一语气/语种。

---

## 10. 与现状代码的差异清单（实施 backlog）

1. **`emails` 表**：`ai_language`、`ai_sentiment`；`process-email` 写入；异常时语言默认 `en`。  
2. **取消/改地址**：无单号 + 开关 + ≤24h → 客户自动模板；compensating → **2h～72h** 内部预警；**不对客户**发缺单号模板。  
3. **总开关 + 分场景开关**：**Supabase secrets**；所有 `sendTemplateReply` 路径前统一校验 **24h**。  
4. **内部预警**：`schedule-compensating-alerts` + **72h 上限** + 去重。  
5. **自动草稿**：拦截/关联后 `status` 仍满足「不排除」候选条件。  
6. **草稿管线**：消费 `ai_language` / `ai_sentiment`。  
7. **Dify DSL**：`email-analysis.yml` 输出与后端字段对齐。  
8. **补偿任务**：`max_retries` 默认 **10**，重试间隔 **30 分钟**（迁移 `20260510120000_compensation_ten_retries_thirty_min.sql` + Edge）。  
9. **风控**：**不调用 Shopify**；ERP 直连按 `erp-api-requirements.md` 迭代。  
10. **自动风控拦截**：§6.4 开关、准入（无单号且未关联 / 超 24h 发件时间）、收信 1 次 + 补偿 3 次、每小时 `:45` cron、开关关终态；人工始终可拦。

---

## 11. 验收检查表（摘要）

- [ ] 总开关关 → 无任何客户自动模板。  
- [ ] 总开关开、分场景关关 → 取消/改地址缺单号不发客户信。  
- [ ] 任意客户自动回复：`received_at` 超过 24h → 不发。  
- [ ] 取消/改地址 + 超 24h → 不发客户信。  
- [ ] `not_provided` → 无内部 compensating 类预警。  
- [ ] compensating：收信 &lt;2h → 无内部预警；2h～72h → 有内部预警（去重）；**&gt;72h** → 无内部预警。  
- [ ] 有单号且关联成功 + 取消/改地址 → 触发拦截（本地 hold，不调 Shopify）。  
- [ ] 破损/缺陷/描述不符 + 首封 + 信息不完整 + ≤24h + 开关 → 可发模板。  
- [ ] `ai_language` / `ai_sentiment` 落库；异常时语言为 `en`。  
- [ ] 自动草稿：1～24h、pending/processing、无草稿、龄≥1h；1～6h Dify、6～24h 本地。  
- [ ] 人工草稿仅本地。  
- [ ] 补偿任务最多 **10** 次失败告警，**30 分钟** 间隔。  
- [ ] 告警页 **resolved** 展示为 **已处理**。  
- [ ] **自建**环境 cron URL 指向自建网关，无错误 `*.supabase.co`。
- [ ] release 操作：仅本地解锁（orders.shipping_hold = false），ERP 侧由运营在 ERP 后台手动操作，不校验 ERP 响应。
- [ ] **自动风控拦截（§6.4）**：开关关 → 无自动拦、无补偿；开关开 → 无单号且未关联 / 发件超 24h **不**自动拦；收信失败后最多 3 次补偿、间隔 ≥1h；用尽失败终态；补偿 cron 为**每小时 `:45`**；开关关闭后进行中记录收敛为拦截失败；**人工**不受开关与 24h 限制。

---

## 12. 文档维护

- **关联文档**：`docs/erp-order-api.md`（订单/ERP）、`docs/self-hosted-supabase.md`（自建发布）、`dify-workflows/README.md`（Dify 部署与密钥）、仓库根目录 **`docs/production-go-live.md` §5.5**（自动风控拦截运维与上线核对）。  
- 规则变更时请同步更新 **§0～§6.4、§7～§9** 与验收表。

---

*版本：2026-05-10 合并产品确认与文档冲突修订；2026-05-13 增补 §6.4 自动风控拦截与根目录 `docs/production-go-live.md` §5.5 交叉引用。*

---

## 13. 实现说明（仓库）

- **迁移**：`20260509120000_emails_ai_language_sentiment.sql`、`20260509120100_cron_schedule_compensating_alerts.sql`、`20260509120200_idx_emails_compensating_received.sql`、**`20260510120000_compensation_ten_retries_thirty_min.sql`**、**`20260513120000_risk_auto_intercept_compensation.sql`**
- **Edge**：`process-email`、`schedule-compensating-alerts`（2h～72h 窗口）、`run-compensation-tasks`（30min 步长、10 次）、`risk-intercept`（不调 Shopify）、**`retry-risk-intercept-compensation`**、`_shared/auto-risk-intercept-policy.ts`、**`RiskLogs`（自动拦截开关）**、`_shared/draft.ts`、`generate-draft` / `schedule-draft-generation`
- **模板**：可在 `reply_templates` 中增加 `trigger_type = risk_missing_order_no`（可选）
- **Secrets**：`AUTO_REPLY_*`、`DIFY_*`、`ALERT_*` 使用 **Supabase Functions secrets**（自建对应 `supabase-selfhost/.env.functions`）
- **上线核对**：[`scripts/verify-customer-automation.sql`](../scripts/verify-customer-automation.sql)（若存在）在 SQL Editor 中执行
- **自建 cron（权威）**：执行 [`scripts/selfhosted/Apply-VaultAndCron.ps1`](../scripts/selfhosted/Apply-VaultAndCron.ps1) 写入 **5 条** `pg_cron`（含 **`run-compensation-tasks-every-30min`**、**`retry-risk-intercept-hourly-at-45`**）。`supabase/migrations` 内若仍有 `*.supabase.co` 的 cron 片段，**以该脚本覆盖结果为准**；详见 `docs/self-hosted-supabase.md`「四步续」。
- **自动风控拦截**：`process-email`（准入与收信 1 次）、`risk-intercept`（幂等与状态机）、补偿 Edge + **§6.4** 字段（如 `next_compensation_at`、补偿剩余次数）；与 [`docs/production-go-live.md`](../../docs/production-go-live.md) **§5.5** 同步验收。
