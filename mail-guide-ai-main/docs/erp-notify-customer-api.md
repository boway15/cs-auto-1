# ERP 订单拦截 — 客户通知接口

## 概述

ERP 在订单拦截后调用客服系统，按固定场景模板向客户发送通知邮件。主题与正文由客服系统配置；收件邮箱由 ERP 传入；**发件邮箱由 ERP 传入的 `site_code` 在「迅捷回邮模板 → 站点邮箱关联」中解析**。

**Endpoint**

```http
POST {SUPABASE_URL}/functions/v1/erp-notify-customer
```

## 鉴权

```http
Authorization: Bearer {ERP_NOTIFY_API_KEY}
```

- 密钥配置在 `supabase-selfhost/.env.functions` 的 `ERP_NOTIFY_API_KEY`
- 勿使用客服 JWT 或 `service_role`

## 请求

```json
{
  "template_code": "risk_shopify",
  "order_no": "SO20240315001",
  "item_count": 4,
  "site_code": "sedeta-us",
  "to_email": "customer@example.com",
  "idempotency_key": "risk_shopify-SO20240315001-evt-001"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `template_code` | 是 | `risk_shopify` \| `risk_payoneer` \| `risk_qty_ge_4` \| `po_box` |
| `order_no` | 是 | 替换模板 `{{order_no}}` |
| `item_count` | 是 | 订单购买总件数（正整数），替换模板 `{{item_count}}` |
| `site_code` | 是 | 独立站站点编码，用于解析发件邮箱；替换模板 `{{site_code}}` |
| `to_email` | 是 | 客户收件邮箱 |
| `idempotency_key` | 是 | 幂等键；**仅成功发信（`status=sent`）时占用** |

> **不需传 `site_name`**：展示名在客服系统「站点邮箱关联」中维护，用于模板 `{{site_name}}`。

### 场景说明

| template_code | 场景 |
|---------------|------|
| `risk_shopify` | Shopify 系统风控订单 |
| `risk_payoneer` | Payoneer 邮件风控订单 |
| `risk_qty_ge_4` | 单订单购买数量 ≥ 4 |
| `po_box` | 收件地址为 PO Box，需客户提供物理街道地址 |

### 模板变量

| 占位符 | 来源 |
|--------|------|
| `{{order_no}}` | ERP |
| `{{item_count}}` | ERP |
| `{{site_code}}` | ERP |
| `{{site_name}}` | 客服系统站点配置（ERP 不传） |

## 成功响应 `200`

```json
{
  "success": true,
  "deduped": false,
  "send_log_id": "uuid",
  "send_no": "SND-20260521-XXXXXXXX",
  "template_code": "risk_shopify",
  "order_no": "SO20240315001",
  "item_count": 4,
  "site_code": "sedeta-us",
  "from_email": "notify@example.com",
  "to_email": "customer@example.com",
  "subject": "Regarding your order SO20240315001",
  "message_id": "<...@domain>"
}
```

- 相同 `idempotency_key` 且此前已成功发送 → `deduped: true`，不重复发信。

## 错误码

| HTTP | code | 说明 |
|------|------|------|
| 401 | `UNAUTHORIZED` | 鉴权失败 |
| 400 | `INVALID_REQUEST` | 参数缺失、`site_code` 为空或 `item_count` 无效 |
| 400 | `INVALID_TEMPLATE` | 未知 template_code |
| 404 | `TEMPLATE_DISABLED` | 模板已停用 |
| 422 | `SITE_NOT_CONFIGURED` | 站点未配置或已停用 |
| 422 | `MAILBOX_SMTP_MISSING` | 站点发件邮箱未找到、未启用或未配置 SMTP |
| 500 | `SMTP_SEND_FAILED` | SMTP 发信失败（含 `send_log_id`） |

### 422 与幂等、发送日志

- 站点/SMTP 等 **422 会写入发送日志**（`status=failed`，`metadata` 含 `site_code`、`error_code` 等），响应体含 `send_log_id`。
- **422 不占用 `idempotency_key`**（失败日志的 `idempotency_key` 为空），配置修复后可用**同一** `idempotency_key` 重试。
- 仅 **发信成功** 的记录会绑定 `idempotency_key`，后续相同 key 返回 `deduped: true`。

## 运维

1. 管理端「迅捷回邮模板」→ **站点邮箱关联**：为每个 ERP 会传的 `site_code` 配置发件邮箱与站点名称。
2. 发件邮箱须在「邮箱配置」中完成 SMTP；可选启用签名（发信时追加在正文末尾）。
3. 同页配置各场景的邮件主题/正文（**不再按场景选择发件邮箱**）。
4. 发信记录见「发送日志」，类型为 **ERP 拦截通知**；详情可查看站点编码/名称。

## 给迅捷 ERP 的变更说明（可转发）

自本版本起，拦截客户通知接口 **必须增加字段 `site_code`**（字符串，与客服系统站点配置一致）。**无需传 `site_name`**。发件邮箱由客服系统按站点解析，不再按场景配置。未传 `site_code` 或站点未配置将返回 422，并在客服系统发送日志中留痕（不消耗幂等键，修复后可重试）。模板支持 `{{order_no}}`、`{{item_count}}`、`{{site_code}}`、`{{site_name}}`。
