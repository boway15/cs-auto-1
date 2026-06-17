# Amazon Dify 工作流处理方案与落地文档

## 1. 背景与结论

`dify-workflows/Ai智能邮件客服-amazon.yml` 是一个面向 Amazon 售后邮件的 Dify `advanced-chat` 应用，当前已覆盖物流类售后处理的主要链路：邮件上下文识别、订单查询、包裹物流查询、店铺 ODR 查询、知识库召回、按物流状态分支生成回复、敏感词处理和最终多语种输出。

当前工作流可以作为业务规则原型继续保留，但不建议直接以现状进入生产。主要原因是：Dify 中直接调用多个内网 ERP/风控接口、环境变量中存在明文业务 token、HTTP 节点与内网 IP 强绑定、异常分支多为直接输出错误、回复结果缺少结构化落库接口。推荐落地方案是：Dify 只负责分类、检索和生成，ERP/物流/ODR/风控等后端能力统一收敛到 Supabase Edge Function `dify-gateway`，密钥与内网访问放在 Functions 环境中管理。

## 2. 当前工作流现状

### 2.1 应用与依赖

- 文件：`mail-guide-ai-main/dify-workflows/Ai智能邮件客服-amazon.yml`
- Dify 模式：`advanced-chat`
- 应用名称：`Ai智能邮件客服`
- DSL 版本：`0.5.0`
- 依赖插件：
  - `langgenius/json_process`
  - `langgenius/azure_openai`
  - `langgenius/deepseek`
  - `yizixuan/text_tools`
  - `langgenius/siliconflow`
- 使用模型：
  - 分类与清洗：`gpt-4o` / Azure OpenAI
  - 生成回复：`deepseek-reasoner`
  - 知识库 rerank：SiliconFlow `netease-youdao/bce-reranker-base_v1`

### 2.2 输入变量

开始节点提供以下输入：

- `AccountId`：账号 ID，必填。
- `OrderId`：订单号，必填。
- `Context`：买家和卖家的历史交流上下文，可选。
- `SiteId`：站点 ID，可选。
- `Token`：业务 token，可选，但当前工作流实际使用的是 Dify 环境变量 `token`。
- `FirstText`：买家首条或当前待处理文本，可选。

### 2.3 内置会话变量与环境变量

会话变量：

- `logisticsPairingFirstList`：首条物流轨迹关键词到业务状态的映射，例如“未上网”“投递失败”。
- `logisticsPairingList`：全轨迹关键词到业务状态的映射，例如“妥投失败”“中途破损”“签收未收到”。
- `SiteId`：默认站点 ID。

环境变量：

- `track718`：物流服务相关 key。
- `token`：业务接口 Bearer token。

注意：当前 YAML 中出现了明文 token。该 token 应视为已泄露，必须从 Dify DSL 中移除并轮换。

### 2.4 主流程

主流程可以按下面的阶段理解：

1. 初始化日期：开始节点进入“获取日期”代码节点，生成当前日期供后续 prompt 使用。
2. 一级分类：识别“物流问题”“质量问题”“其他问题”“无关问题”。
3. 非物流类拦截：质量、其他、无关会进入“无法处理”答复，不继续自动生成完整邮件。
4. 二次分类：物流问题继续识别“签收未收到”“一件多包”“中途破损”“催促发货”“其他”。
5. 并行取数：二次分类后并行调用订单、包裹、店铺 ODR、客服历史知识库、客服规则库。
6. 数据整理：订单、物流、店铺响应分别经过 Code 与 Template 节点转换为给 LLM 使用的上下文文本。
7. 物流状态识别：通过 `logisticsPairingFirstList` 和 `logisticsPairingList` 从轨迹中识别“未上网”“妥投失败”“中途破损”“签收未收到”等状态。
8. 条件分支：按识别结果进入专门的 LLM 节点；未命中特定规则时进入“通用处理”。
9. 回复合并：多个候选 LLM 输出进入变量聚合器。
10. 输出清洗：思维链清理、签名与占位符文本替换、特殊符号清理。
11. 敏感词处理：调用敏感词接口提取违禁词，再由 LLM 替换敏感表达。
12. 多语种输出：若最终文本不含英文，则补充英文版本；最终由“最终结果”Answer 节点输出。

### 2.5 当前外部接口

工作流直接调用了以下内网接口：

- 订单详情：`/AukeysOrder/OrderInfo/GetEmailOrderDetail`
- 包裹信息：`/AukeysOrder/PackageInfo/GetOrderPackage`
- 店铺 ODR：`/api/AmazonSellerPerformanceV2Service/detail`
- 敏感词识别：`/customer/sensitiveword`

这些接口都通过 Dify HTTP Request 节点直接调用，并使用 `env.token` 作为 Bearer token。

## 3. 主要问题与风险

### 3.1 安全风险

- YAML 中含明文业务 token，导入、提交、分享 DSL 时都会泄露。
- Dify 工作流直接保存后端接口访问凭据，不符合当前仓库 `dify-workflows/README.md` 中“ERP 凭据放在 Functions secrets 或 `.env.functions`”的要求。
- 内网 IP 与端口暴露在工作流内，后续环境迁移或权限收敛困难。

处理要求：

- 立即轮换当前 token。
- 从 DSL 中删除 `workflow.environment_variables.token` 的真实值。
- Dify 节点不再直接调用 ERP/ODR/敏感词接口，统一改调 `dify-gateway`。

### 3.2 架构风险

- Dify 同时承担编排、业务接口访问、风控、清洗与邮件内容生成，职责过重。
- HTTP 节点直接依赖内网 IP，生产、测试、本地环境难以复用同一份 DSL。
- 错误分支直接把 `error_message` 回复给用户，不适合自动邮件发送。
- `Token` 开始变量存在但主流程未统一使用，变量来源不清晰。

处理要求：

- Dify 只保留 AI 编排能力。
- Supabase Edge Functions 负责鉴权、后端接口访问、重试、日志、幂等和敏感信息管理。
- Dify 输出统一为结构化草稿，由后端决定是否自动发送、进入人工审核或触发拦截。

### 3.3 业务准确性风险

- “质量问题”“其他问题”“无关问题”当前直接返回无法处理，若生产需要覆盖更广场景，需要单独扩展分支。
- 条件分支依赖物流轨迹关键词，关键词覆盖不足会进入通用处理。
- 部分 prompt 要求“不能出现中文”，但后续“多语种输出”可能在非英文输入后追加英文，需要明确最终业务口径。
- “敏感词检测”先调用接口再由 LLM 改写，改写后没有再次调用敏感词接口做闭环校验。

处理要求：

- 先以物流类售后为 MVP 范围。
- 敏感词处理至少做一次二次校验，或由后端 `risk-intercept` 决定是否允许自动发送。
- 每个分支保留 `intent`、`logistics_status`、`risk_level`、`reply_text` 等结构化字段。

## 4. 推荐目标架构

### 4.1 分层职责

Dify 工作流：

- 邮件意图分类。
- 物流状态识别。
- 知识库召回。
- 按业务规则生成客服回复草稿。
- 输出清洗后的候选回复。

Supabase Edge Functions：

- `process-email`：接收邮件、调用 Dify、保存 AI 分析结果。
- `generate-draft` / `schedule-draft-generation`：调用草稿生成类 Dify 工作流。
- `dify-gateway`：向 Dify 暴露统一后端能力入口。
- `risk-intercept`：敏感词、评论诱导、退款/补寄等风险策略校验。

ERP / 物流 / 风控后端：

- 仅接受 Edge Functions 的服务端调用。
- 凭据只存储在 `.env.functions` 或 Supabase secrets。

### 4.2 Dify Gateway 动作扩展

现有 `dify-gateway` 已支持：

- `get_email_context`
- `get_order_by_email`
- `risk_intercept`

为承接 Amazon 工作流，建议扩展以下 action：

- `get_amazon_order_detail`：按 `account_id`、`order_id` 查询 Amazon 订单详情。
- `get_amazon_package_info`：按 `order_id` 查询包裹与轨迹。
- `get_amazon_seller_performance`：按 `account_id`、`site_id`、`end_date` 查询店铺 ODR。
- `detect_sensitive_words`：封装当前敏感词接口。
- `normalize_amazon_context`：可选，把订单、物流、店铺响应统一转换为 Dify 需要的上下文对象。

### 4.3 Dify HTTP 节点改造方式

把现有多个 HTTP Request 节点改为调用统一地址：

```text
POST {SUPABASE_URL}/functions/v1/dify-gateway
```

请求头：

```text
x-api-key: {{#env.gateway_api_key#}}
content-type: application/json
x-trace-id: {{#sys.workflow_run_id#}}
```

请求体示例：

```json
{
  "action": "get_amazon_order_detail",
  "payload": {
    "account_id": "{{#1741571480087.AccountId#}}",
    "order_id": "{{#1741571480087.OrderId#}}"
  }
}
```

Dify 中只保留：

- `gateway_url`
- `gateway_api_key`

不再保存 ERP token、账号密码、内网接口地址。

## 5. 落地实施方案

### 阶段一：安全止血与基线确认

目标：先消除密钥泄露和环境不可控风险。

任务：

- 轮换当前 YAML 中出现的业务 token。
- 从 Dify 应用环境变量中删除真实 `token` 值。
- 确认目标 Dify 实例已安装当前 DSL 依赖插件。
- 在 Dify 中导入当前 YAML，只做人工验证，不接入自动发送。
- 记录当前工作流应用 ID、发布版本、API Key 和模型配置。

验收：

- DSL 文件不包含真实 token。
- Dify 画布可打开，插件节点可渲染。
- 使用测试订单手动运行一次，确认分类、取数、生成、清洗链路的当前表现。

### 阶段二：后端 Gateway 扩展

目标：把 Dify 直接访问内网接口改为 Edge Function 单出口。

任务：

- 扩展 `supabase/functions/dify-gateway/index.ts` 的 action 类型。
- 在 `.env.functions` 中新增 ERP/ODR/敏感词接口配置，例如：
  - `AMAZON_ERP_BASE_URL`
  - `AMAZON_ODR_BASE_URL`
  - `SENSITIVE_WORD_BASE_URL`
  - `ERP_API_TOKEN` 或 OAuth 凭据
- 为每个 action 实现参数校验、超时、错误归一化。
- 响应中保留 `trace_id`、`success`、`code`、`message`、`data`。
- 对 Dify 调用加 `x-api-key` 校验，复用现有 `DIFY_GATEWAY_API_KEY`。

验收：

- 本地或自建环境可通过 HTTP 调用 `dify-gateway` 获取订单、包裹、ODR、敏感词结果。
- 错误响应不泄露内网 token 或完整后端异常栈。
- `trace_id` 能贯穿 Dify、Functions 和后端接口日志。

### 阶段三：Dify DSL 改造

目标：保留 AI 编排，替换外部接口访问方式。

任务：

- 将“查询订单信息”改为调用 `get_amazon_order_detail`。
- 将“查询包裹信息”改为调用 `get_amazon_package_info`。
- 将“查询店铺ODR”改为调用 `get_amazon_seller_performance`。
- 将“识别违禁词”改为调用 `detect_sensitive_words`。
- 删除 `env.token`，新增 `env.gateway_url` 和 `env.gateway_api_key`。
- 调整 Code 节点解析逻辑，适配 gateway 的统一响应结构 `data`。
- 错误分支改为内部失败提示，不直接输出后端原始错误给买家。

验收：

- Dify 手动运行时，所有 HTTP 节点只访问 `dify-gateway`。
- 无内网 IP、业务 token 出现在 DSL 中。
- 订单、物流、店铺模板转换结果与改造前等价或更稳定。

### 阶段四：结构化输出与后端落库

目标：让 Amazon 工作流可以被 `process-email` 或草稿调度稳定消费。

任务：

- 明确 Dify 最终输出协议，建议返回：
  - `reply_text`：最终客服回复正文。
  - `intent_level_1`：一级分类。
  - `intent_level_2`：二级分类。
  - `logistics_status`：未上网、妥投失败、签收未收到、中途破损、催促发货或通用。
  - `risk_words`：命中的敏感词列表。
  - `risk_level`：`low`、`medium`、`high`。
  - `requires_human_review`：是否必须人工审核。
  - `trace_id`：链路追踪 ID。
- 后端调用 Dify 后解析结构化输出。
- 高风险或解析失败时，不自动发送，只进入人工草稿。
- 将 AI 结果写入 `emails.ai_summary`、`emails.ai_entities` 或现有草稿字段。

验收：

- 前端工作台可看到 Amazon 邮件草稿和关键分类结果。
- 解析失败时有明确错误提示，不产生空回复。
- 高风险样例不会自动发送。

### 阶段五：业务验收与灰度

目标：在真实邮件前完成样例集验证。

测试集建议：

- 未上网：首条轨迹命中“Shipment information sent to FedEx”。
- 妥投失败：轨迹含“Returning to shipper”或地址无效。
- 签收未收到：轨迹含 delivered，但买家声称未收到。
- 中途破损：轨迹含 damaged。
- 催促发货：买家询问何时发货或物流长期停滞。
- 其他物流：关键词未命中特定分支，进入通用处理。
- 非物流：质量、其他、无关问题不会自动套用物流方案。
- 多语言：德语、法语、西语、英语输入。
- 敏感词：包含 review、discount、free、删评、改评、邀评等表达。

灰度策略：

- 第 1 阶段只生成草稿，不自动发送。
- 第 2 阶段仅低风险物流类自动草稿，人工点击发送。
- 第 3 阶段按邮箱或店铺逐步打开自动发送，但保留 `risk-intercept` 拦截。

## 6. 工时评估

按现有代码基础估算：

- 安全止血与现状基线：0.5 天。
- `dify-gateway` action 扩展：1.5 到 2 天。
- Dify DSL 节点替换与解析适配：1 到 1.5 天。
- 结构化输出与后端落库适配：1 天。
- 样例集验证、prompt 调整、灰度文档：1 到 1.5 天。

总计建议按 5 到 6 人天排期。若需要同时扩展质量问题、退款审批、库存查询、自动发送闭环，建议单独拆二期。

## 7. 上线检查清单

上线前必须确认：

- DSL 中没有真实 token、账号密码、内网固定 IP。
- Dify 只调用 `dify-gateway`，不直接访问 ERP/ODR/敏感词后端。
- `.env.functions` 已配置 Dify 与 Amazon 相关后端变量。
- `DIFY_GATEWAY_API_KEY` 已配置，Dify HTTP 节点请求带 `x-api-key`。
- 所有测试样例均有可解释输出。
- 高风险样例进入人工审核。
- 失败分支不会把后端异常直接发给买家。
- 已记录 Dify 应用发布版本和 API Key。
- 已同步 Edge Functions 到自建 Supabase 或 Supabase Cloud 对应环境。

## 8. 回滚方案

如果上线后出现生成质量或接口稳定性问题：

- 立即关闭自动发送，只保留草稿生成。
- 将相关邮箱的 Amazon 自动处理开关关闭。
- 回退 `DIFY_ANALYZE_URL` / `DIFY_DRAFT_URL` 到上一版已发布 Dify 应用。
- Edge Functions 保留新增 gateway action，不影响旧流程。
- 保留失败样例和 `trace_id`，用于回放修复 prompt 或解析逻辑。

## 9. 后续优化建议

- 把物流状态关键词从 Dify 会话变量迁移到数据库或配置文件，便于运营维护。
- 将 prompt 中的业务规则拆成知识库文档，减少 DSL 体积。
- 对敏感词处理做二次校验，避免 LLM 改写后仍残留风险词。
- 将最终回复改为 JSON 结构化输出，再由后端模板化渲染成邮件正文。
- 为每个分支维护固定测试样例，形成 Dify 发布前回归集。
