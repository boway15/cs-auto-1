# ERP 正式环境接口示例（联调摘录）

## 1. 文档说明

- **用途**：记录正式环境（`bestwo.net:9443`）下 OAuth2 取 Token、OMS 查单、Java 网关订单拦截的**请求形态与响应外壳**，便于与 Apifox / 现场抓包对照。
- **Method 约定**：鉴权、OMS 查单、订单拦截均为 **`POST`**（与 [`erp-order-api.md`](./erp-order-api.md) 一致；拦截接口的 `orderId` 在 Query 中传递）。
- **与主文档关系**：测试环境 Base、联调流程与时序图以 [`erp-order-api.md`](./erp-order-api.md) 为准；本文档侧重**正式环境** URL 与响应示例摘录。
- **安全**：禁止在仓库中保存真实账号、密码、`access_token`、`refresh_token`。下列示例均使用占位符；本地调试请用环境变量或 `scripts/erp-fetch-prod-token.ps1` 注入凭据。

---

## 2. 正式环境 Base URL

| 用途 | Base（HTTPS） |
| --- | --- |
| 鉴权（Token） | `https://loginserver.bestwo.net:9443` |
| OMS 订单查询 | `https://omsapi.bestwo.net:9443` |
| Java 网关（订单拦截等） | `https://gatewayjava.bestwo.net:9443` |

---

## 3. 鉴权：获取 Token

### 3.1 请求

- **URL**：`POST /connect/token`（完整 URL：`https://loginserver.bestwo.net:9443/connect/token`）
- **Content-Type**：`application/x-www-form-urlencoded`

### 3.2 表单字段（正式）

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `username` | 是 | ERP 登录名 |
| `password` | 是 | 正式环境密码字段名为 **`password`**（与测试环境 `pw` 不同） |
| `grant_type` | 是 | 固定 `password` |
| `client_id` | 是 | 正式一般为 **`ERP`** |

### 3.3 curl 示例（凭据勿写进文件）

```bash
curl --location --request POST 'https://loginserver.bestwo.net:9443/connect/token' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "username=${ERP_USERNAME}" \
  --data-urlencode "password=${ERP_PASSWORD}" \
  --data-urlencode 'grant_type=password' \
  --data-urlencode "client_id=${ERP_CLIENT_ID:-ERP}"
```

PowerShell 可取 Token：`scripts/erp-fetch-prod-token.ps1`（见 [`erp-order-api.md`](./erp-order-api.md) §3.4）。

### 3.4 响应字段（示例结构）

正式联调中曾出现 `expires_in` 为 **43200**（秒）等较长有效期，并返回 `refresh_token`；实际以 IdP 返回为准。

```json
{
  "access_token": "eyJ...",
  "expires_in": 43200,
  "token_type": "Bearer",
  "refresh_token": "<若返回则妥善保管，勿入库到 Git>",
  "scope": "openid profile roles ... BestOMSNewApi OMSApi ..."
}
```

> 日志与文档中**不要**打印完整 JWT；排错时可只记录 `sub`、`exp` 或截断后几位。

---

## 4. OMS：查询订单（QueryOrderInfo）

### 4.1 请求

- **Method**：`POST`
- **Path**：`/AukeysOrder/OrderInfo/QueryOrderInfo`
- **完整 URL**：`https://omsapi.bestwo.net:9443/AukeysOrder/OrderInfo/QueryOrderInfo`
- **Headers**：
  - `Content-Type: application/json`
  - `Authorization: Bearer {access_token}`

### 4.2 Body（JSON）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `email` | string | 视业务 | 客户/站点邮箱等，用于查询 |
| `ebayOrderId` | string | 否 | 可为空字符串 `""`，与 ERP 约定为准 |

### 4.3 curl 示例

```bash
ACCESS_TOKEN='从鉴权接口获取'

curl --location --request POST \
  'https://omsapi.bestwo.net:9443/AukeysOrder/OrderInfo/QueryOrderInfo' \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer ${ACCESS_TOKEN}" \
  --data-raw '{
    "email": "buyer@example.com",
    "ebayOrderId": ""
  }'
```

> 无需在客户端重复设置 `Host`、`Connection`；由 HTTP 客户端自动处理即可。

### 4.4 响应示例（业务未查到单）

外层表示 HTTP/网关成功；`data` 内为业务结果（示例为「未查询到订单信息」）。

```json
{
  "success": true,
  "code": 200,
  "timestamp": 1778337329800,
  "businessCode": 2000000000,
  "traceId": "8afdf0bcb6fb4c8087e3575547499b59",
  "data": {
    "orderId": "123456",
    "success": false,
    "message": "未查询到订单信息"
  }
}
```

调用方应区分：**HTTP 与外层 `code`** 与 **`data` 内业务 `success` / `message`**，避免将「无单」当作网络错误无限重试。

---

## 5. Java 网关：订单拦截（order-blocking-by-order-ids）

### 5.1 请求

- **Method**：`POST`
- **Path**：`/report/website/orders/order-blocking-by-order-ids`
- **Query**：`orderId={ERP订单号}`
- **完整 URL 示例**：`https://gatewayjava.bestwo.net:9443/report/website/orders/order-blocking-by-order-ids?orderId=SEDETA58827`
- **Headers**：`Authorization: Bearer {access_token}`

### 5.2 curl 示例

```bash
ACCESS_TOKEN='从鉴权接口获取'
ORDER_ID='SEDETA58827'

curl --location --request POST \
  "https://gatewayjava.bestwo.net:9443/report/website/orders/order-blocking-by-order-ids?orderId=${ORDER_ID}" \
  --header "Authorization: Bearer ${ACCESS_TOKEN}"
```

### 5.3 响应示例（与查单类似外壳）

```json
{
  "success": true,
  "code": 200,
  "timestamp": 1778337329800,
  "businessCode": 2000000000,
  "traceId": "8afdf0bcb6fb4c8087e3575547499b59",
  "data": {
    "orderId": "123456",
    "success": false,
    "message": "未查询到订单信息"
  }
}
```

> 拦截成功/失败的真实 `message`、`businessCode` 枚举以 ERP 接口说明为准；此处仅作结构参考。

---

## 6. 统一响应外壳（便于适配层解析）

| 字段 | 说明 |
| --- | --- |
| `success` | 外层是否成功（与 HTTP 状态结合判断） |
| `code` | HTTP 层或网关层常用 200 |
| `businessCode` | 业务码，需与 ERP 字典对齐 |
| `traceId` | 链路追踪 ID，排错与审计建议落库 |
| `data` | 业务体，内含订单维度 `orderId`、`success`、`message` 等 |

---

## 7. 相关文档与脚本

| 资源 | 说明 |
| --- | --- |
| [`erp-order-api.md`](./erp-order-api.md) | 测试/正式鉴权、拦截路径、联调流程与时序图 |
| [`erp-api-requirements.md`](./erp-api-requirements.md) | 对内目标契约与产品需求 |
| `scripts/erp-fetch-prod-token.ps1` | 正式环境拉取 Token（环境变量注入） |

---

## 8. 凭据泄露后的处理（若曾将真实密码/Token 写入 Git）

1. **立即**在 ERP/IdP 侧修改密码并作废已泄露 Token。
2. 从仓库历史中清理敏感提交（如 `git filter-repo`），并通知安全/运维。
3. 今后仅使用环境变量、密钥管理器或 Supabase Secrets，不再将明文写入 `docs/`。
