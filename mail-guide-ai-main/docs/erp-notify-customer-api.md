# ERP 订单拦截 — 客户通知接口

## 概述

ERP 在订单拦截后调用客服系统，按固定场景模板向客户发送通知邮件。主题与正文由客服系统配置；收件邮箱由 ERP 传入。

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
  "to_email": "customer@example.com",
  "idempotency_key": "risk_shopify-SO20240315001-evt-001"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `template_code` | 是 | `risk_shopify` \| `risk_payoneer` \| `risk_qty_ge_4` |
| `order_no` | 是 | 替换模板 `{{order_no}}` |
| `to_email` | 是 | 客户收件邮箱 |
| `idempotency_key` | 是 | 幂等键，重复成功请求返回 `deduped: true` |

### 场景说明

| template_code | 场景 |
|---------------|------|
| `risk_shopify` | Shopify 系统风控订单 |
| `risk_payoneer` | Payoneer 邮件风控订单 |
| `risk_qty_ge_4` | 单订单购买数量 ≥ 4 |

## 成功响应 `200`

```json
{
  "success": true,
  "deduped": false,
  "send_log_id": "uuid",
  "send_no": "SND-20260521-XXXXXXXX",
  "template_code": "risk_shopify",
  "order_no": "SO20240315001",
  "from_email": "notify@example.com",
  "to_email": "customer@example.com",
  "subject": "Regarding your order SO20240315001",
  "message_id": "<...@domain>"
}
```

## 错误码

| HTTP | code | 说明 |
|------|------|------|
| 401 | `UNAUTHORIZED` | 鉴权失败 |
| 400 | `INVALID_REQUEST` | 参数缺失或格式错误 |
| 400 | `INVALID_TEMPLATE` | 未知 template_code |
| 404 | `TEMPLATE_DISABLED` | 模板已停用 |
| 422 | `SENDER_NOT_CONFIGURED` | 场景未配置发件邮箱 |
| 422 | `MAILBOX_SMTP_MISSING` | 发件邮箱 SMTP 未配置 |
| 500 | `SMTP_SEND_FAILED` | SMTP 发信失败 |

## 运维

1. 管理端「ERP 通知模板」为三个场景分别配置发件邮箱与文案。
2. 发件邮箱须在「邮箱配置」中完成 SMTP；可选启用签名（发信时追加在正文末尾）。
3. 发信记录见「发送日志」，类型为 **ERP 拦截通知**。
