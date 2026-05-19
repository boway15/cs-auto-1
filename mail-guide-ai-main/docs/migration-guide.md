# mail-guide-ai 新环境迁移（当前仓库基线）

> **生产默认：自建 Supabase（`supabase-selfhost`）+ Dify（`dify/docker`）+ 本前端。**  
> 完整步骤与排障见 `docs/self-hosted-supabase.md`、`docs/startup-commands.md`。  
> 架构备选与长期规划见 `docs/risk-and-plan.md`（规划稿）。

---

## 1. 需要准备的目录

在新机器上克隆或拷贝后，至少涉及：

- `d:\Docker\project\cs-main\mail-guide-ai-main`
- `d:\Docker\project\cs-main\dify\docker`
- `d:\Docker\project\cs-main\supabase-selfhost`（生产 / 团队默认）

---

## 2. 前置检查

```powershell
node --version
npm --version
docker --version
docker compose version
npx supabase --version
```

---

## 3. 推荐执行顺序

1. **自建 Supabase**：按 `docs/self-hosted-supabase.md`（迁移、`vault`/cron、Functions 同步、`.env.functions`）。
2. **Dify**：

```powershell
cd d:\Docker\project\cs-main\dify\docker
docker compose -f docker-compose.cs.yml up -d
docker compose -f docker-compose.cs.yml ps
```

访问 `http://localhost:8090`。

3. **导入 Dify 工作流**：在 Dify 后台导入 `mail-guide-ai-main/dify-workflows/` 下的 `email-analysis.yml`、`draft-generation.yml`（及其他团队约定的工作流），发布并创建 API Key。
4. **公网暴露 Dify（Edge 调本机 Dify 时需要）**：当前仓库默认用 **compose 内的 `dify-ngrok`**，见 `docs/startup-commands.md`「4.3 ngrok」。URL 变更后需同步 `supabase-selfhost/.env.functions` 中的 `DIFY_*`。
5. **前端**：`copy .env.selfhosted.example .env`（或按团队模板），填 Kong URL 与 anon key；`npm ci` + `npm run dev`，或 `docker compose up -d`。

---

## 4. 数据库与函数（自建）

- 迁移：`docs/self-hosted-supabase.md` 与 `docs/startup-commands.md`「4.5」中的 `db push` / 初始化说明。
- Edge Functions：自建栈用 `scripts/sync-functions-to-selfhost.ps1`，**不要**依赖 `npx supabase functions deploy`（该命令面向 Supabase Cloud）。

---

## 5. 验证清单

- Dify：`http://localhost:8090` 可登录。
- 前端：`http://localhost:8080` 可打开登录页。
- 自建：`supabase-selfhost` 下 `docker compose ps` 主要服务 healthy；cron 与 `vault.secrets` 已按 `self-hosted-supabase.md` 核对。

---

## 附录：若仍维护历史 Supabase Cloud 项目

CLI 的 `link`、`functions deploy`、`secrets set` 与云端 cron 校验等，已集中到 `docs/startup-commands.md`「二、仅本地开发…」与「4.4 Supabase 云端（CLI，可选）」，避免与本迁移文重复维护。
