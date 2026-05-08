---
name: "dify-dsl-workflow-creator"
description: "创建兼容 Dify 1.14 的 DSL YAML 工作流文件，用于通过导入 DSL 文件创建 Dify 工作流。适合需要离线或批量创建工作流的场景。"
---

# Dify DSL 工作流文件创建指南

## 概述

Dify DSL（Domain Specific Language）是 Dify 定义的 YAML 格式应用工程文件标准。本技能用于创建兼容 Dify 1.14 的 DSL 文件，通过「导入 DSL 文件」方式创建工作流应用（而非在 UI 中手动创建）。

**适用场景**：
- 需要离线或批量创建 Dify 工作流
- 需要程序化生成/修改工作流
- 需要跨 Dify 实例迁移工作流

---

## DSL 文件结构（参考 Dify 官方测试夹具）

```yaml
app:
  description: 应用描述
  icon: "\U0001F916"          # 图标 emoji（YAML 安全转义）
  icon_background: '#E0F2FE'
  mode: workflow              # workflow 或 advanced-chat
  name: app-name
  use_icon_as_answer_icon: false
dependencies: []               # 必填
kind: app
version: 0.3.1                 # 必填，DSL 版本号
workflow:
  conversation_variables: []
  environment_variables: []
  features:
    file_upload:
      enabled: false
    opening_statement: ''
    retriever_resource:
      enabled: false
    sensitive_word_avoidance:
      enabled: false
    speech_to_text:
      enabled: false
    suggested_questions: []
    suggested_questions_after_answer:
      enabled: false
    text_to_speech:
      enabled: false
  graph:
    edges:
      - # ... 连接线定义
    nodes:
      - # ... 节点定义
    viewport:
      x: 0
      y: 0
      zoom: 1.0
```

**⚠️ 关键规则**：`version: 0.3.1` 和 `dependencies: []` 是必填项，缺失会导致导入后节点内容为空。

---

## 节点通用结构

Dify DSL 中所有节点的顶层结构完全一致，实际类型通过 `data.type` 区分：

```yaml
- data:
    desc: ''                  # 可选描述
    selected: false
    title: 节点标题
    type: llm                 # 实际节点类型：start / llm / code / end / http-request / if-else / tool / answer 等
    # ... 类型特定字段
  height: 90
  id: unique_node_id          # 全局唯一，用于被其他节点/边引用
  position:
    x: 384
    y: 200
  positionAbsolute:
    x: 384
    y: 200
  selected: false
  sourcePosition: right
  targetPosition: left
  type: custom                # ⚠️ 固定为 custom！
  width: 244
```

**⚠️ 特别注意**：
- 顶层 `type` 永远是 `custom`（不是 `llm`、`start` 等）
- `id` 是字符串，在 edge 中用 `source`/`target` 引用
- `height`/`width` 影响 UI 布局
- `position`/`positionAbsolute` 通常相同

---

## 各节点类型的数据结构

### 1. Start 节点（`data.type: start`）

```yaml
data:
  desc: ''
  selected: false
  title: 开始
  type: start
  variables:
    - label: 变量标签
      max_length: 500          # 文本长度限制
      options: []               # 下拉选项（固定空数组）
      required: true
      type: text-input          # text-input / paragraph / number / file-list 等
      variable: variable_name   # 变量名，用于 {{#start_node.var_name#}} 引用
```

### 2. LLM 节点（`data.type: llm`）

```yaml
data:
  desc: 节点描述
  title: LLM 节点
  type: llm
  model:
    provider: deepseek          # 模型供应商（需在 Dify 中配置 API Key）
    name: deepseek-chat         # 模型名称
    mode: chat                  # chat / completion
  prompt_template:
    - role: system
      text: |
        系统提示词...
    - role: user
      text: |
        用户输入，可引用变量：{{#start_node.subject#}}
  vision:
    enabled: false
    configs:
      variable_selector: []
  memory:
    enabled: false
    window:
      enabled: false
      size: 50
  context:
    enabled: false
    variable_selector: []
  structured_output:
    enabled: false
  retry_config:
    enabled: false
    max_retries: 1
    retry_interval: 1000
    exponential_backoff:
      enabled: false
      multiplier: 2
      max_interval: 10000
  variables: []                 # ⚠️ 必填空数组
```

**LLM 节点的输出变量**（内置，无需声明）：
- `text` — LLM 返回的文本
- `reasoning_content` — 推理内容（如 DeepSeek R1）
- `usage` — Token 用量
- `finish_reason` — 结束原因

### 3. Code 节点（`data.type: code`）

```yaml
data:
  code: |
    def main(arg1: str, arg2: str) -> dict:
        # Python 处理逻辑
        return {"result": "输出"}
  code_language: python3
  desc: 节点描述
  outputs:
    result:                     # 输出变量名
      children: null            # 固定为 null
      type: string              # string / number / object / array / json
  selected: false
  title: 代码节点
  type: code
  variables:                    # 输入变量
    - value_selector:
        - upstream_node_id      # 上游节点 ID
        - upstream_output_var   # 上游节点输出变量名
      variable: arg1            # 此 node 的 main 函数参数名
```

**代码节点注意事项**：
- `outputs` 是 **字典**（map），不是列表
- `variables` 是 **列表**（list），不是字典
- main 函数签名参数名需与 `variables[].variable` 一一对应
- `children: null` 是固定写法
- 代码缩进是 YAML 的一部分，需保持层级正确

### 4. End 节点（`data.type: end`）

```yaml
data:
  desc: ''
  outputs:
    - value_selector:
        - upstream_node_id
        - upstream_output_var
      value_type: string        # string / number / object / array
      variable: output_name     # 输出变量名
  selected: false
  title: 结束
  type: end
```

**⚠️ End 节点的 `outputs` 是列表**，每个 output 包含：
- `value_selector` — `[节点ID, 输出变量名]`
- `value_type` — 类型
- `variable` — 对外暴露的变量名

### 5. HTTP Request 节点（`data.type: http-request`）

```yaml
data:
  desc: 调用外部 API
  title: HTTP Request
  type: http-request
  method: GET                    # GET / POST / PUT / PATCH / DELETE / HEAD
  url: 'https://api.example.com/endpoint?param={{#start_node.var#}}'
  authorization:
    type: bearer                 # no-auth / bearer / basic / custom
    config:
      api_key: '{{#start_node.api_key#}}'
  headers: ''
  params: ''
  body:
    type: none                   # none / json / form-data / x-www-form-urlencoded / binary-text
    data: ''
  timeout:
    connect: 10
    read: 30
    write: 30
  retry_config:
    enabled: false
    max_retries: 1
    retry_interval: 1000
    exponential_backoff:
      enabled: false
      multiplier: 2
      max_interval: 10000
```

**HTTP 节点的输出变量**（内置）：
- `body` — 响应体字符串
- `status_code` — HTTP 状态码
- `headers` — 响应头字典
- `files` — 文件列表

---

## Edge（连接线）定义

```yaml
edges:
  - data:
      isInIteration: false
      isInLoop: false            # 必填字段
      sourceType: start          # 源节点 data.type
      targetType: llm            # 目标节点 data.type
    id: unique-edge-id
    source: source_node_id
    sourceHandle: source         # 固定为 source
    target: target_node_id
    targetHandle: target         # 固定为 target
    type: custom
    zIndex: 0
```

**分支 Edge**（if-else 节点输出）：
- `sourceHandle: "true"` — 条件为真分支
- `sourceHandle: "false"` — 条件为假分支

---

## 嵌入 HTML 中的多行

YAML 中多行字符串使用 `|`（保留换行）或 `>-`（折叠换行）：

```yaml
code: |
  def main() -> dict:
      return {"result": "hello"}
```

```yaml
answer: >
  这是一段很长的文本，
  换行会被折叠成空格。
```

---

## 常见问题排查

| 问题 | 原因 | 解决 |
|------|------|------|
| 导入后节点存在但内容为空 | missing `version: 0.3.1` or `dependencies: []` | 补全顶层字段 |
| 节点创建失败/报错 | `type` 顶层写成了 `llm` 而非 `custom` | 确保顶层 `type: custom`，实际类型写在 `data.type` |
| LLM 节点模型不生效 | `model` 字段格式不对 | 使用 `provider: deepseek | openai`，不加路径前缀 |
| Code 节点语法错误 | YAML 缩进被破坏 | 确保 `code: |` 后面缩进正确 |
| End 节点无输出 | `outputs` 格式用了 dict 而非 list | End 节点的 outputs 是列表，Code/LLM 节点的 outputs/变量是内置 |
| 导入提示版本过高 | DSL 版本太新 | 用 `version: 0.3.1`（兼容 Dify 1.14） |

---

## 工作流设计规则

1. 必须有且只能有一个 Start 节点
2. 必须有且只能有一个 End 节点（workflow 模式）或 Answer 节点（advanced-chat 模式）
3. 不能有环（DAG，有向无环图）
4. 变量引用使用 `{{#node_id.variable_name#}}` 语法
5. 每个节点必须有全局唯一的 `id`
6. model provider 必须在 Dify 中预先配置好 API Key

---

## 参考来源

- Dify 测试夹具：`api/tests/fixtures/workflow/*.yml`（Dify 官方测试 DSL）
- Dify 文档：https://docs.dify.ai
- 社区 DSL 合集：github.com/wwwzhouhui/dify-for-dsl

