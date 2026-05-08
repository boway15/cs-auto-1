# Dify 工作流部署与配置指南（当前仓库）

本文档用于把本机 Dify 与 `mail-guide-ai-main` 的 Supabase Edge Functions 对接。

## 1. 当前环境基线

- 项目路径：`d:\Docker\project\cs-main\mail-guide-ai-main`
- Dify 路径：`d:\Docker\project\cs-main\dify\docker`
- Dify Compose：`docker-compose.cs.yml`
- Dify 本机入口：`http://localhost:8090`

> 本文档以 `docker-compose.cs.yml` 为准。若你使用其他 Dify Compose 文件，请按实际端口调整。

## 2. 启动 Dify

```powershell
cd d:\Docker\project\cs-main\dify\docker
docker compose -f docker-compose.cs.yml up -d
docker compose -f docker-compose.cs.yml ps
```

检查：

- `http://localhost:8090` 可打开 Dify 管理页面
- 关键服务容器：`dify-api`、`dify-worker`、`dify-web`、`dify-nginx`

## 3. 导入工作流 DSL

DSL 文件位于：

- `dify-workflows/email-analysis.yml`（应用名：**独立站智能客服-邮件智能分析**）
- `dify-workflows/draft-generation.yml`（应用名：**独立站智能客服-邮件草稿生成**）
- `dify-workflows/NewEmailDraft.yaml`（应用名：**独立站智能客服-上下文增强草稿生成**）

在 Dify 后台导入后，确认应用可正常打开并可发布。

**模型与插件（必读）**

- 三份 DSL 默认 LLM：**DeepSeek 市场插件**，`model.name` 为 `deepseek-v4-flash`，`model.provider` 为 **`langgenius/deepseek/deepseek`**。
- 请在 Dify 中已安装 **langgenius/deepseek** 插件并配置 API Key，且模型列表中启用 `deepseek-v4-flash`。
- DSL 顶层 **`dependencies`** 含该插件的 `marketplace_plugin_unique_identifier`。若你升级了插件或换了 Dify 实例，请在本机新建任意工作流并**导出 DSL**，用其中的 `dependencies` 整段替换本仓库对应 YAML，否则可能出现画布或模型节点渲染错误。

> 2026-05 业务升级：`email-analysis.yml` 已新增 `business_intent`（7 类唯一枚举，单选）输出，供后端 `emails.business_intent` 使用；`intent` 保留为 legacy 字段用于过渡期兼容。

## 4. 发布并记录 API 信息

发布两个工作流后，为每个工作流创建 API Key，记录：

- `analyze_api_url`（通常是 `http://localhost:8090/v1/workflows/run`）
- `analyze_api_key`
- `draft_api_url`（通常同上）
- `draft_api_key`

## 5. 配置 ngrok（可选但推荐）

因为 Supabase Edge Functions 在云端，若 Dify 在本机，需要公网 URL。

1) 先配置 token（仅一次）：

```powershell
ngrok config add-authtoken <your-ngrok-token>
```

2) 启动 tunnel：

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main
ngrok start --config dify-workflows/ngrok.yml dify-api
```

3) 获取公网地址：

```powershell
curl.exe http://localhost:4040/api/tunnels
```

> `dify-workflows/ngrok.yml` 默认映射本机 `8090`。

## 6. 设置 Supabase Functions Secrets

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main

npx supabase functions secrets set DIFY_GATEWAY_API_KEY="replace_with_strong_key"
npx supabase functions secrets set DIFY_ANALYZE_URL="https://xxxx.ngrok-free.app/v1/workflows/run"
npx supabase functions secrets set DIFY_ANALYZE_KEY="app-xxxxx1"
npx supabase functions secrets set DIFY_DRAFT_URL="https://xxxx.ngrok-free.app/v1/workflows/run"
npx supabase functions secrets set DIFY_DRAFT_KEY="app-xxxxx2"
```

自动草稿调度规则：

- 0~4 小时：`schedule-draft-generation` 调用 Dify 长草稿
- 4~24 小时：`schedule-draft-generation` 走本地草稿
- 24 小时后：仅人工本地生成

人工点击“生成草稿”已固定为本地模式，不再依赖 Dify 可用性。

## 7. 部署相关 Edge Functions

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main

npx supabase functions deploy sync-mailbox --no-verify-jwt
npx supabase functions deploy process-email --no-verify-jwt
npx supabase functions deploy generate-draft
npx supabase functions deploy schedule-draft-generation --no-verify-jwt
npx supabase functions deploy close-email
npx supabase functions deploy send-reply
npx supabase functions deploy risk-intercept
npx supabase functions deploy dify-gateway --no-verify-jwt
npx supabase functions deploy get-email-context --no-verify-jwt
npx supabase functions deploy get-order-by-email --no-verify-jwt
```

## 8. 最小验证

1) 在 Dify 中手动运行两个工作流，确认无报错  
2) 在 Supabase Dashboard 手动调用 `process-email`  
3) 在前端工作台触发“生成草稿”，确认本地产出  
4) 手动调用 `schedule-draft-generation`，确认 0~4h 邮件走 Dify、4~24h 邮件走本地  

## 9. 常见问题

- **Dify 打不开**：确认 `docker-compose.cs.yml` 已启动，并访问 `8090` 不是 `8081`
- **Edge Function 调 Dify 超时**：检查 ngrok 是否在线，URL 是否与 secrets 一致
- **草稿生成失败**：确认 `DIFY_DRAFT_*` 或 `LOVABLE_API_KEY` 至少有一套可用
- **dify-gateway 返回未授权**：确认 `DIFY_GATEWAY_API_KEY` 已设置且请求带 `x-api-key`
