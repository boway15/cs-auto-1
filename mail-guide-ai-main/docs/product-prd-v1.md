# 客服闭环优化 PRD v1（按当前仓库落地）

## 1. 目标

建立“可自动化 + 可人工兜底 + 可审计”的客服邮件处理闭环，覆盖：

- 业务状态统一：待处理、处理中、已回复、已处理
- 意图统一：7 类业务意图单选，并支持人工修改
- 订单关联语义统一：未提供、未找到、已关联
- SLA 时效统一：24h/48h/72h/72h+
- 草稿统一：自动双轨（Dify + 本地）+ 人工本地
- 告警统一：落库 + 发邮 + 幂等去重
- 审计统一：人工动作可追溯

## 2. 状态定义

- `pending`：待处理
- `processing`：处理中
- `replied`：系统已发送回复（自动结案）
- `closed`：人工结案（已处理）

说明：`replied` 与 `closed` 都是完成态，但语义不同，UI 必须区分。

## 3. 意图定义（唯一枚举）

主字段：`emails.business_intent`

- `order_cancel`：订单取消
- `address_change`：订单改地址
- `damaged`：破损
- `defect`：产品缺陷
- `description_mismatch`：商品描述不符
- `logistics`：物流问题
- `other`：其他问题

兼容字段：`emails.intent` 与 `emails.intent_legacy`（过渡期保留）

## 4. 订单关联语义

- `not_provided`：未识别到订单号且未人工关联（不做推荐）
- `not_found`：提供订单号但系统未找到
- `linked`：已关联

补偿任务策略：

- 每小时重试
- 默认最多 6 次
- 不区分店铺

## 5. SLA 定义

计算基准：`emails.received_at`

- 来源：邮件 RFC 5322 Date 头
- Date 头缺失或无效：回退入库时间

分桶（仅 `pending` / `processing` 展示）：

- `within_24h`（24 小时内）
- `within_48h`（48 小时内）
- `within_72h`（72 小时内）
- `over_72h`（72 小时+）

## 6. 草稿策略

### 自动草稿（调度任务）

触发条件：

- `status in ('pending','processing')`
- 当前无非空草稿
- `received_at` 在 24 小时内

分流：

- 0~4h：Dify 长草稿
- 4~24h：本地草稿
- >=24h：不自动

### 人工草稿

- 工作台点击“生成草稿”固定走本地
- 支持指导思想 `guidance`

## 7. 风控策略

- 当业务意图为 `order_cancel` 或 `address_change` 且已关联订单时：必须尝试拦截
- 无单号/无关联订单时：不自动拦截，并在页面显示业务说明

## 8. 告警策略

告警事件（本期）：

1. 风控拦截失败
2. 订单补偿失败
3. 自动回复失败

触达：

- 写入 `ops_alerts`
- 发送告警邮件（同事件仅发一次）
- 发件：`caobaowei123@163.com`
- 收件：`caobaowei@bestwo.com`

## 9. 页面范围

- 工作台 `Workbench`：主处理台（状态、意图、关联、草稿、结案、SLA）
- 告警页 `Alerts`：查看/处理运营告警

## 10. 审计要求

人工操作必须写入：

- `email_processing_events`
- `audit_logs`

覆盖：人工结案、人工改意图、人工关联/解绑、人工拦截。

## 11. 验收

1. `replied` 与 `closed` 可区分且可搜索/筛选
2. 业务意图严格 7 类单选，可人工修改
3. `not_provided` 不展示推荐订单
4. 补偿任务最多 6 次，失败后仅 1 条告警 + 1 封邮件
5. SLA 分桶正确
6. 草稿策略满足 0~4h / 4~24h / >=24h
7. 人工再生成始终本地
8. 关键人工动作可追溯

