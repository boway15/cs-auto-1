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

> 2026-06 业务升级：`email-analysis.yml` 的 `business_intent` 为 **10 类**（售后 7 + `amazon_marketplace` / `product_inquiry` / `conversation_idle` / `solution_accepted`）。Edge `process-email` 传入 `body_latest`（客户最新回复，无引用）。**修改 YAML 后须在 Dify 重新导入并发布**，并同步 Edge Functions。

## 4. 发布并记录 API 信息

发布两个工作流后，为每个工作流创建 API Key，记录：

- `analyze_api_url`（通常是 `http://localhost:8090/v1/workflows/run`）
- `analyze_api_key`
- `draft_api_url`（通常同上）
- `draft_api_key`

## 5. 配置 ngrok（Edge 调本机 Dify 时需要）

**推荐（与 `docs/startup-commands.md` 一致）：** 使用 `dify/docker` 栈内的 **`dify-ngrok`** 容器，配置在 `dify/docker/ngrok/ngrok.yml`，查看隧道：`curl.exe http://localhost:4040/api/tunnels`。

**备选：** 本机安装 ngrok CLI 时，可参考仓库内 `dify-workflows/ngrok.yml` 自行 `ngrok start …`（与 compose 内 ngrok 二选一即可，避免重复占端口）。

## 6. 配置 Dify 相关环境变量

- **自建 Supabase（默认）：** 在 `supabase-selfhost/.env.functions` 中配置 `DIFY_*`、`DIFY_GATEWAY_API_KEY` 等，模板见 `docs/self-hosted-env-functions.example`；改完后按 `docs/startup-commands.md`「4.5」重建 `functions`。
- **Supabase Cloud（历史）：** 使用 `npx supabase functions secrets set …`，见 `docs/startup-commands.md`「4.4」。

### 6.1 ERP 订单查询与 Dify（Edge 单出口）

- **OAuth2 与 OMS 查单、Java 网关拦截**由 Supabase Edge 实现（`get-order-by-email`、`risk-intercept` 等），凭据放在 **Functions secrets** 或自建 **`supabase-selfhost/.env.functions`** 的 `ERP_*` 变量（见 [`docs/erp-order-api.md`](../docs/erp-order-api.md)、[`docs/self-hosted-env-functions.example`](../docs/self-hosted-env-functions.example)）。
- **禁止**在 Dify 工作流环境变量中配置 `ERP_USERNAME` / `ERP_PASSWORD`；Dify 仅需能访问 **Kong 上的 Edge**（与现有 `DIFY_*` 同源网络策略）。
- 工作流中需要订单上下文时，使用 **HTTP 请求**节点调用：

  `GET {VITE_SUPABASE_URL 或自建 Kong}/functions/v1/get-order-by-email?order_no={单号}` **或** `...?email={买家邮箱}`，**至少填一个查询参数**（也可两个都填）。

  请求头：`Authorization: Bearer {SERVICE_ROLE_KEY 或已登录用户的 access_token}`（与当前函数鉴权一致：`service_role` 或 `anon`+用户 JWT）。

- 成功响应含 `found`、`order` 字段；经 OMS 命中时可能含 `erp_trace_id`，便于与 ERP 对账。

自动草稿调度规则：

- 0~4 小时：`schedule-draft-generation` 调用 Dify 长草稿
- 4~24 小时：`schedule-draft-generation` 走本地草稿
- 24 小时后：仅人工本地生成

人工点击「生成草稿」默认走 Dify 草稿工作流（本地兜底见 Edge `generate-draft`）；勿与邮件分析的 Key 混用。

## 7. 同步 Edge Functions

- **自建：** `mail-guide-ai-main/scripts/sync-functions-to-selfhost.ps1`（见 `docs/self-hosted-supabase.md`）。
- **云端：** `npx supabase functions deploy …`（见 `docs/startup-commands.md`「4.4」）。

## 8. 最小验证

1) 在 Dify 中手动运行两个工作流，确认无报错  
2) 在 Supabase Studio 或自建调试入口手动触发 `process-email`（或按团队约定方式）  
3) 在前端工作台触发“生成草稿”，确认本地产出  
4) 手动调用 `schedule-draft-generation`，确认 0~4h 邮件走 Dify、4~24h 邮件走本地  

## 9. 常见问题

- **Dify 打不开**：确认 `docker-compose.cs.yml` 已启动，并访问 `8090` 不是 `8081`
- **Edge Function 调 Dify 超时**：检查 ngrok 隧道是否在线（`4040`），且 `DIFY_ANALYZE_URL` / `DIFY_DRAFT_URL` 与自建 `.env.functions`（或云端 secrets）一致
- **草稿生成失败**：确认 `DIFY_DRAFT_*` 或 `LOVABLE_API_KEY` 至少有一套可用
- **Dify「获取邮件上下文」曾报 `url is required` / `InvalidURLError`**：`NewEmailDraft` 已改为由 Edge `callDifyDraftWorkflow` **随请求传入** `gateway_url`、`gateway_api_key`、`max_search_depth`（开始变量），不再依赖 Dify 应用环境变量。请重新导入 DSL；并确保 Functions 已配置 **`DIFY_GATEWAY_API_KEY`**，且 **`DIFY_GATEWAY_URL` 或 `SUPABASE_URL`** 至少其一可用（未显式配置 URL 时将自动拼装 `{SUPABASE_URL}/functions/v1/dify-gateway`）。
- **dify-gateway 返回未授权**：确认 `DIFY_GATEWAY_API_KEY` 已设置且请求带 `x-api-key`
