# 客服自动化与邮件处理方案（完整版）

本文档汇总 **收信 → 同步 → 分析 → 分流 → 自动回复 / 内部预警 → 草稿** 的产品口径与实现约束，作为开发与验收依据。  
**现状代码可能尚未完全实现本文档**；以本文档为目标态，改造时逐项对齐。

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
- **有单号未匹配**：客户提供了订单号，本地库暂无对应订单 → 写入 **补偿任务**（如 `order_compensation_tasks`），`association_status = compensating`。
- **未提供单号**：无可用订单号 → `not_provided`（或等价语义）。

关联成功后，后续拦截、草稿等逻辑依赖 **linkedOrders.length > 0**。

---

## 4. 两套时间线（客户自动回复 vs 内部预警）

二者 **独立**，需同时判断：

| 类型 | 时间条件 | 用途 |
|------|----------|------|
| **客户自动回复** | `now - received_at ≤ 24h` | 仅在此窗口内给客户发自动模板；**超过 24h 一律不发**。 |
| **内部预警** | `now - received_at ≥ 2h` | 如 **有单号但未关联成功**（compensating）等场景，**首次**内部预警邮件不早于收信后 2 小时；需 **去重**（同类预警同一邮件不重复轰炸）。 |

**说明**：

- 客户 24h 与内部 2h **互不替代**。例如收信 3h、仍 compensating：可发内部预警；若业务上已超过 24h，则仍 **不对客户** 自动回复。
- **取消/改地址** 且邮件 **已超过 24h**：**禁止**对客户自动回复；内部是否继续对「长期 compensating」告警，可另设年龄上限（可选，未强制）。

---

## 5. 开关与通用自动回复逻辑

### 5.1 开关（建议配置名）

| 配置 | 作用 |
|------|------|
| **总开关**（如 `AUTO_REPLY_CUSTOMER_ENABLED`） | 关闭时，**所有**给客户自动模板 **一律不发**。 |
| **取消/改地址缺单号**（如 `AUTO_REPLY_RISK_MISSING_ORDER_NO`） | 在总开关打开前提下，单独控制「取消/改地址 + 缺单号」是否对客户发索要单号类模板。 |

### 5.2 客户自动回复通用前置条件

在 **各业务分支** 条件满足时，发送前 **必须** 同时满足：

1. **总开关** 打开；  
2. **`received_at` 距今 ≤ 24h**；  
3. 对应 **分场景开关**（若该场景有独立开关）；  
4. 模板存在、`auto_send`、冷却与去重逻辑正常（与现有 `reply_templates` / `sendTemplateReply` 一致）。

不满足任一项 → **跳过发送**，建议写处理事件（如 `auto_reply_skipped_*`）便于排查。

---

## 6. 按意图分流（目标行为）

### 6.1 取消订单（`order_cancel`）或 改地址（`address_change`）

| 条件 | 客户自动回复 | 订单/风控 | 内部预警 |
|------|----------------|-----------|----------|
| **未提供订单号**（无法关联） | 总开关 + 分场景开关开 **且** ≤24h：发索要单号等模板；否则不发 | **不**调用拦截 | 按产品需要可选（默认可不重复发客户信场景下的内部信） |
| **有单号且关联成功** | 一般不先发「缺单号」模板 | **调用** `risk-intercept`（hold 等） | 拦截失败时现有告警机制 |
| **有单号但未关联成功**（compensating） | **不对客户**发「缺单号」模板（客户已提供单号） | **不**拦截（直至关联成功） | **≥2h** 后发 **内部预警邮件**（ERP/人工处理），去重 |

**特别强调**：**超过 24h** 的取消/改地址邮件 **不**对客户自动回复（即使开关打开）。

### 6.2 破损（`damaged`）、缺陷（`defect`）、描述不符（`description_mismatch`）

| 条件 | 行为 |
|------|------|
| **近 30 天首封**（同发件人）+ **信息不完整**（缺单号或缺附件等，与 `missing_elements` 一致） | 命中自动模板回复时，仍须满足 **§5.2 通用条件**（含 ≤24h、总开关） |
| 非首封或信息完整 | 按现有逻辑进入人工或其它分支，**不**强行自动回复 |

（「首封」口径与现网 `process-email` 中 `isFirstEmail` 一致：近 30 天同发件人无其它邮件。）

### 6.3 其它意图

按现有分类、优先级、SLA 桶等继续处理；自动回复仅在产品定义的分支内启用。

---

## 7. 内部预警（有单号未关联）

- **触发**：`association_status` 为 compensating（或等价：有单号、已写补偿任务、仍未 `linked`）。  
- **时间**：**收信后满 2 小时** 才允许发 **首次** 内部预警邮件。  
- **实现建议**：`process-email` 当下若不足 2h，只落库/事件，**不发**预警；由 **定时任务**（可与现有 30min cron 同栈或独立）扫描满足条件的邮件再发送。  
- **去重**：同一 `email_id` + 同类预警类型只发一次（或按冷却策略）。

预警内容至少建议包含：`email_id`、客户邮箱、主题/摘要、`order_no`、`business_intent`、关联状态。

---

## 8. 自动生成草稿

| 项 | 口径 |
|----|------|
| **调度** | 每 **30 分钟**（如 pg_cron 调 `schedule-draft-generation`） |
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
- 生成时应可读 `emails.ai_summary`、`ai_language`、`ai_sentiment`（实现后）以统一语气/语种。

---

## 10. 与现状代码的差异清单（实施 backlog）

以下为对照当前仓库常见实现时的 **待办**，便于排期：

1. **`emails` 表**：新增 `ai_language`、`ai_sentiment`；`process-email` 写入；异常时语言默认 `en`。  
2. **取消/改地址**：无单号 + 开关 + ≤24h → 客户自动模板；有单号未关联 → ≥2h 内部预警，**不对客户**发缺单号模板。  
3. **总开关 + 分场景开关**：环境变量或配置表；所有 `sendTemplateReply` 路径前统一校验 **24h**。  
4. **内部预警**：封装发送逻辑 + 定时扫描 compensating + 2h + 去重。  
5. **自动草稿**：核对拦截/关联后 `status` 是否仍满足「不排除」的候选条件；必要时调整。  
6. **草稿管线**：消费 `ai_language` / `ai_sentiment`。  
7. **Dify DSL**：保持 `email-analysis.yml` 输出与后端字段对齐。

---

## 11. 验收检查表（摘要）

- [ ] 总开关关 → 无任何客户自动模板。  
- [ ] 总开关开、分场景关关 → 取消/改地址缺单号不发客户信。  
- [ ] 任意客户自动回复：`received_at` 超过 24h → 不发。  
- [ ] 取消/改地址 + 超 24h → 不发客户信。  
- [ ] 有单号、compensating：收信 &lt;2h → 无内部预警；≥2h → 有内部预警（去重）。  
- [ ] 有单号且关联成功 + 取消/改地址 → 触发拦截。  
- [ ] 破损/缺陷/描述不符 + 首封 + 信息不完整 + ≤24h + 开关 → 可发模板。  
- [ ] `ai_language` / `ai_sentiment` 落库；异常时语言为 `en`。  
- [ ] 自动草稿：1～24h、pending/processing、无草稿、龄≥1h；1～6h Dify、6～24h 本地；候选不排除（满足 SQL 条件即尝试）。  
- [ ] 人工草稿仅本地。

---

## 12. 文档维护

- **关联文档**：`docs/architecture-design.md`（总架构）、`docs/erp-order-api.md`（订单/ERP）、`dify-workflows/README.md`（Dify 部署与密钥）。  
- 规则变更时请同步更新 **§4～§9** 与验收表。

---

*版本：2026-05-09 根据产品确认整理。*

---

## 13. 实现说明（仓库）

- **迁移**：`20260509120000_emails_ai_language_sentiment.sql`、`20260509120100_cron_schedule_compensating_alerts.sql`、`20260509120200_idx_emails_compensating_received.sql`
- **Edge**：`process-email`（开关、24h、取消/改地址模板、`ai_language`/`ai_sentiment`）、`schedule-compensating-alerts`（compensating + 满 2h 内部告警）、`_shared/draft.ts`（本地草稿按语言/情绪）、`generate-draft` / `schedule-draft-generation`（查询新列）
- **模板**：可在 `reply_templates` 中增加 `trigger_type = risk_missing_order_no`（可选；否则仍可用 `missing_order_no` / `missing_any`）
- **Secrets**：见 `.env.dify.example` 中 `AUTO_REPLY_*` 说明（可用 `npx supabase secrets set …` 配置）
- **上线核对 SQL**：[`scripts/verify-customer-automation.sql`](../scripts/verify-customer-automation.sql) 在 Dashboard SQL Editor 中执行
