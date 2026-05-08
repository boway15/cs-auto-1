# ERP 订单接口需求文档

> **用途：** 客服邮件系统与 ERP 订单系统的对接接口规范，提报 ERP 团队评审与开发。
> 涉及两个接口：**订单查询**、**订单拦截（风控）**。

---

## 0. 当前实现边界说明（重要）

为避免对接预期偏差，先说明当前仓库状态：

- 前端 `Erp.tsx` 已支持配置 `base_url`、鉴权方式、`order_endpoint`、字段映射；
- 但当前 `supabase/functions/get-order-by-email` 实现是查询 Supabase 本地 `orders` 缓存表，不是直接请求 ERP HTTP；
- `risk-intercept` 当前核心落点是本地订单状态与 Shopify 标签流程，ERP 拦截接口尚未在 Edge Function 中形成统一直连调用链。

因此本文档是**目标 ERP 接口契约**，用于后续把“ERP 直连链路”补齐。

---

## 1. 业务场景

### 场景 A：订单查询

客服收到客户邮件后，系统根据邮件中提取的订单号（或客户邮箱），向 ERP 查询该订单的详细信息，包括订单状态、物流状态、商品信息、收货地址等，供客服参考并回复客户。

### 场景 B：订单拦截

当客户提出取消订单、修改收货地址等高时效性请求时，客服需要对尚未发货的订单执行暂停发货（拦截），待问题确认后再恢复发货（放行）。该操作可由系统自动触发，也可由客服手动执行，所有拦截行为均需可追溯。

---

## 2. 接口一：订单查询

### 2.1 基本信息

| 项目 | 说明 |
|---|---|
| 用途 | 根据订单号或客户邮箱查询订单详情 |
| 调用方 | 客服邮件系统（服务端） |
| 调用频率 | 正常约 100 次/天，峰值约 500 次/天 |
| 超时要求 | 连接超时 5s，读取超时 10s |
| 调用时机 | 邮件到达自动分析时、客服手动查询时、定时补偿重试时 |

### 2.2 请求

**URL**

```
GET {base_url}/orders
```

示例：
```
https://erp.example.com/api/v2/orders?order_no=SO20240315001
```

**Query 参数**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `order_no` | string | 二选一 | 订单号 |
| `customer_email` | string | 二选一 | 客户邮箱，用于按邮箱反查订单 |
| `limit` | integer | 否 | 返回条数上限，默认 10，最大 50 |

> 说明：`order_no` 和 `customer_email` 至少传一个；两个都传时，返回同时满足条件的订单。

**请求头**

```
Authorization: Bearer {api_token}
Content-Type: application/json
Accept: application/json
```

认证方式见 [第 4 节](#4-认证方式)。

### 2.3 响应

**成功 200 — 有结果**

```json
{
  "data": [
    {
      "order_no": "SO20240315001",
      "customer_email": "john@example.com",
      "customer_name": "John Smith",
      "order_status": "processing",
      "shipping_status": "in_transit",
      "tracking_no": "1Z999AA10123456784",
      "product_summary": "Blue Dress (M) x1",
      "total_amount": 49.99,
      "currency": "USD",
      "ordered_at": "2024-03-15T10:30:00Z",
      "shipping_address": {
        "name": "John Smith",
        "line1": "123 Main St",
        "city": "New York",
        "state": "NY",
        "zip": "10001",
        "country": "US",
        "phone": "+1234567890"
      },
      "line_items": [
        {
          "sku": "DRS-BLUE-M",
          "name": "Blue Dress",
          "variant": "M",
          "quantity": 1,
          "unit_price": 49.99
        }
      ],
      "fulfillment_status": "unfulfilled",
      "financial_status": "paid",
      "hold_status": null
    }
  ],
  "total": 1,
  "page": 1
}
```

**成功 200 — 无结果（订单不存在）**

```json
{
  "data": [],
  "total": 0,
  "page": 1
}
```

> **重要：** 订单不存在时请返回 HTTP 200 + 空数组，不要返回 404。返回 404 会被调用方误判为接口异常而反复重试，空数组表示"确实查不到"，调用方将进入等待重查的逻辑，不会反复请求。

**错误 4xx / 5xx**

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid API token"
  }
}
```

错误码说明见 [第 5 节](#5-错误码规范)。

### 2.4 字段说明

| 字段 | 类型 | 必返回 | 说明 |
|---|---|---|---|
| `order_no` | string | ✅ | 订单号（唯一标识） |
| `customer_email` | string | ✅ | 客户邮箱 |
| `customer_name` | string | 推荐 | 客户姓名 |
| `order_status` | string | ✅ | 订单状态：`pending` / `processing` / `completed` / `cancelled` |
| `shipping_status` | string | 推荐 | 物流状态：`unshipped` / `in_transit` / `delivered` / `returned` |
| `tracking_no` | string | 推荐 | 物流单号 |
| `product_summary` | string | 推荐 | 商品摘要（用于客服快速了解订单内容） |
| `total_amount` | number | 推荐 | 订单金额 |
| `currency` | string | 推荐 | 币种（USD / EUR / CNY 等） |
| `ordered_at` | string | 推荐 | 下单时间（ISO 8601） |
| `shipping_address` | object | 推荐 | 收货地址（用于修改地址场景） |
| `line_items` | array | 可选 | 商品明细 |
| `fulfillment_status` | string | 可选 | 发货状态 |
| `financial_status` | string | 可选 | 支付状态 |
| `hold_status` | string | 推荐 | 拦截状态：`null`（无拦截）/ `held`（已拦截） |

> 注意：上述字段名为期望使用的名称。若 ERP 实际返回的字段名不同，调用方可通过映射表适配，不影响接口对接。

---

## 3. 接口二：订单拦截 / 放行

### 3.1 基本信息

| 项目 | 说明 |
|---|---|
| 用途 | 对订单执行发货拦截（hold）或恢复发货（release） |
| 调用方 | 客服邮件系统（服务端） |
| 调用频率 | 约 20 次/天 |
| 超时要求 | 连接超时 5s，读取超时 10s |
| **幂等性** | 必须支持，通过 `idempotency_key` 去重 |

### 3.2 请求

**URL**

```
POST {base_url}/orders/intercept
```

示例：
```
https://erp.example.com/api/v2/orders/intercept
```

**请求体**

```json
{
  "order_no": "SO20240315001",
  "action": "hold",
  "reason": "客户要求取消订单",
  "reason_category": "cancel_order",
  "operator": "cs_agent@company.com",
  "idempotency_key": "risk:abc-123:hold:cancel_order"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `order_no` | string | ✅ | 订单号 |
| `action` | string | ✅ | `hold`（拦截/暂停发货）或 `release`（放行/恢复发货） |
| `reason` | string | 推荐 | 拦截原因，用于 ERP 内备注 |
| `reason_category` | string | 推荐 | 原因分类：`cancel_order` / `change_address` / `risk_review` |
| `operator` | string | 推荐 | 操作人标识（客服邮箱） |
| `idempotency_key` | string | ✅ | 幂等键，同一 key 重复调用不应产生额外影响 |

**幂等要求（ERP 侧需实现）**

- 收到请求后记录 `idempotency_key`
- 若该 key 已处理成功 → 返回原结果，不重复执行业务逻辑
- 若该 key 之前处理失败 → 允许重试
- key 有效期建议 ≥ 7 天

### 3.3 响应

**成功 200**

```json
{
  "order_no": "SO20240315001",
  "action": "hold",
  "status": "success",
  "hold_status": "held",
  "message": "订单已成功拦截，暂不发货",
  "processed_at": "2024-03-16T08:15:00Z"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `order_no` | string | 订单号 |
| `action` | string | 执行的操作（`hold` / `release`） |
| `status` | string | 执行结果：`success` / `failed` |
| `hold_status` | string | 拦截后当前状态：`held` / `released` / `null` |
| `message` | string | 可选的描述信息 |
| `processed_at` | string | 处理时间（ISO 8601） |

**幂等重复请求 — 200**

```json
{
  "order_no": "SO20240315001",
  "action": "hold",
  "status": "success",
  "hold_status": "held",
  "message": "已拦截（重复请求，未重复执行）",
  "idempotent": true,
  "processed_at": "2024-03-16T08:15:00Z"
}
```

**业务拒绝 — 200（操作不可执行）**

```json
{
  "order_no": "SO20240315001",
  "action": "hold",
  "status": "failed",
  "hold_status": null,
  "message": "订单已完成发货，无法拦截",
  "error_code": "ORDER_ALREADY_SHIPPED",
  "processed_at": "2024-03-16T08:15:00Z"
}
```

**错误 4xx / 5xx — 接口级异常**

```json
{
  "error": {
    "code": "ORDER_NOT_FOUND",
    "message": "订单不存在"
  }
}
```

### 3.4 边界情况约定

| 场景 | 期望行为 |
|---|---|
| 重复请求相同 `idempotency_key` | 返回原结果，不重复执行 |
| 订单已发货 | 返回 `error_code: ORDER_ALREADY_SHIPPED`，不执行拦截 |
| 订单已取消 | 返回 `error_code: ORDER_CANCELLED`，不执行拦截 |
| 订单已处于 held 状态，再次收到 hold 请求 | 返回成功，状态不变 |
| 订单未处于 held 状态，收到 release 请求 | 返回成功，状态不变 |
| 订单不存在 | 返回 `error_code: ORDER_NOT_FOUND` |
| hold 中的订单被仓库操作发货 | ERP 应在发货前校验 `hold_status`，阻止发货 |

---

## 4. 认证方式

可以选择以下三种认证方式，请贵方选择其中一种实现：

**方式 A：Bearer Token（推荐）**

```
Authorization: Bearer {api_token}
```

Token 签发，配置到系统后使用。

**方式 B：API Key**

```
X-API-Key: {api_key}
```

**方式 C：Basic Auth**

```
Authorization: Basic {base64(username:password)}
```

建议优先选择 **Bearer Token**。

---

## 5. 错误码规范

| HTTP 状态码 | 错误码 | 适用场景 |
|---|---|---|
| 200 | — | 正常（含订单查询无结果、拦截业务不可执行等） |
| 400 | `INVALID_PARAMS` | 参数校验失败（缺少必填参数、格式错误等） |
| 400 | `INVALID_ACTION` | `action` 取值不是 `hold` 或 `release` |
| 401 | `UNAUTHORIZED` | Token 无效或已过期 |
| 403 | `FORBIDDEN` | 无权限访问该资源 |
| 409 | `DUPLICATE` | 幂等键冲突（已处理过且结果不同） |
| 422 | `ORDER_ALREADY_SHIPPED` | 订单已发货，不可拦截 |
| 422 | `ORDER_CANCELLED` | 订单已取消，不可拦截 |
| 422 | `ORDER_NOT_FOUND` | 订单不存在（仅拦截接口） |
| 429 | `RATE_LIMITED` | 请求频率超限 |
| 500 | `INTERNAL_ERROR` | 服务端内部错误 |
| 503 | `SERVICE_UNAVAILABLE` | 服务暂时不可用 |

---

## 6. 接入约定

### 6.1 接口地址

| 接口 | 方法 | 路径 | 说明 |
|---|---|---|---|
| 订单查询 | GET | `/orders` | 拼接在 Base URL 之后，如 `https://erp.example.com/api/v2/orders` |
| 订单拦截 | POST | `/orders/intercept` | 同上，如 `https://erp.example.com/api/v2/orders/intercept` |

Base URL 由IT提供，客服系统在配置中填入即可。

### 6.2 交付要求

| 序号 | 交付物 | 说明 |
|---|---|---|
| 1 | 两个接口的实现与上线 | 订单查询 + 订单拦截，整体交付 |
| 2 | Base URL + 认证凭据（Token） | 生产环境 API 地址和密钥 |
| 3 | 测试环境或沙箱地址（如有） | 用于客服系统联调测试 |
| 4 | 接口文档或 Swagger（如有） | 便于双方对齐 |

### 6.3 期望时间

两个接口整体交付，不拆分，上线后客服系统接入使用。
