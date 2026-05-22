# Apifox 导入说明

## 方式一：导入 cURL（推荐）

1. 打开 `erp-notify-customer.curl`（模板）或本机 `erp-notify-customer-local.curl`（已填本地 Key）
2. Apifox → **导入** → **cURL**（或接口页 **快速请求** → **导入 cURL**）
3. **每次只粘贴一条** `curl` 命令（从 `curl` 起到 JSON 结束，不要带 `#` 注释行）
4. 将 `your-test@example.com` 改成你的测试邮箱
5. 模板文件里把 `YOUR_ERP_NOTIFY_API_KEY` 换成 `.env.functions` 中的值

## 方式二：OpenAPI

1. Apifox → **项目设置** → **导入数据** → **OpenAPI/Swagger**
2. 选择文件：`erp-notify-customer.openapi.yaml`

## 方式三：Postman 集合

1. Apifox → **导入** → **Postman Collection**
2. 选择文件：`erp-notify-customer.postman.json`

## 环境变量

在 Apifox **环境管理** 中新建「本地 Docker」，配置：

| 变量 | 示例值 |
|------|--------|
| `baseUrl` | `http://localhost:8000` |
| `erpNotifyApiKey` | 与 `supabase-selfhost/.env.functions` 中 `ERP_NOTIFY_API_KEY` 一致 |
| `testToEmail` | 你的测试收件邮箱 |

## 鉴权

- 类型：**Bearer Token**
- Token 填环境变量 `{{erpNotifyApiKey}}`（不要手写 `Bearer ` 前缀）

## 测试前检查

1. `supabase-edge-functions` 容器已启动
2. 管理端 **ERP 通知模板** 已为对应场景配置 **发件邮箱**
3. 发件邮箱在 **邮箱配置** 中 SMTP 测试通过

## 文件路径

- OpenAPI：`mail-guide-ai-main/docs/apifox/erp-notify-customer.openapi.yaml`
- Postman：`mail-guide-ai-main/docs/apifox/erp-notify-customer.postman.json`
