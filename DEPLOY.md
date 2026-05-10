# cs-main 常用部署命令速查

路径默认：`d:\Docker\project\cs-main`（请按本机实际目录修改）。

更完整的分场景说明见：

- [`mail-guide-ai-main/docs/startup-commands.md`](mail-guide-ai-main/docs/startup-commands.md)
- [`mail-guide-ai-main/docs/self-hosted-supabase.md`](mail-guide-ai-main/docs/self-hosted-supabase.md)

---

## 一、自建 Supabase（`supabase-selfhost`）

### 首次或改 `docker-compose.yml` / `.env` 后

```powershell
cd d:\Docker\project\cs-main\supabase-selfhost
docker compose pull
docker compose up -d
docker compose ps
```

### 只改 Edge Functions 源码或 `_shared` 后（如 `sync-mailbox`）

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main\scripts
.\sync-functions-to-selfhost.ps1

cd d:\Docker\project\cs-main\supabase-selfhost
docker compose up -d --force-recreate --no-deps functions
```

若改过 compose 里 functions 的 `env_file`，可能需要先执行：

`mail-guide-ai-main\scripts\selfhosted\Ensure-FunctionsEnvFileInCompose.ps1`（见 `self-hosted-supabase.md`）。

### 只改 `supabase-selfhost\.env.functions` 后

```powershell
cd d:\Docker\project\cs-main\supabase-selfhost
docker compose up -d --force-recreate --no-deps functions
```

### sync-mailbox 体积上限（可选环境变量）

在 `.env.functions` 中可配置（不设则用代码内默认值）：

- `MAIL_SYNC_FULL_BODY_MAX_BYTES` — 无附件嫌疑时完整 RFC822 上限（默认约 5MB）
- `MAIL_SYNC_FULL_BODY_WITH_ATTACH_MAX_BYTES` — BODYSTRUCTURE 已标记有附件时的上限（默认约 25MB）

说明见：`mail-guide-ai-main/docs/self-hosted-env-functions.example`

---

## 二、mail-guide-ai 前端（Docker）

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main
docker compose build
docker compose up -d
```

无缓存重建：

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main
docker compose build --no-cache
docker compose up -d
```

默认访问：`http://localhost:8080`（端口以 `mail-guide-ai-main/docker-compose.yml` 为准）。

构建时从同目录 `.env` 读取 `VITE_SUPABASE_*`；浏览器须能访问到其中配置的 Supabase 网关地址。

---

## 三、Dify（本仓库 cs 配置）

```powershell
cd d:\Docker\project\cs-main\dify\docker
docker compose -f docker-compose.cs.yml up -d
docker compose -f docker-compose.cs.yml ps
```

---

## 四、Docker / 机器重启后快速拉起

```powershell
cd d:\Docker\project\cs-main\dify\docker
docker compose -f docker-compose.cs.yml up -d

cd d:\Docker\project\cs-main\supabase-selfhost
docker compose up -d

cd d:\Docker\project\cs-main\mail-guide-ai-main
docker compose up -d
```

---

## 五、Supabase 云端（不用自建时）

在 `mail-guide-ai-main` 目录用 CLI 部署函数（按需增减函数名）：

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main
npx supabase functions deploy sync-mailbox --no-verify-jwt
npx supabase functions deploy process-email --no-verify-jwt
```

更多函数与 `secrets set` 示例见 `mail-guide-ai-main/docs/startup-commands.md` 第四节。

---

## 六、自建库数据库迁移（临时暴露 db 端口时）

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main
$env:PGSSLMODE = "disable"
npx supabase db push --db-url "postgresql://postgres:<POSTGRES_PASSWORD>@127.0.0.1:54323/postgres"
```

端口与是否给 `db` 加 `ports` 以 `mail-guide-ai-main/docs/self-hosted-supabase.md` 为准。

---

## 七、自建：Vault + pg_cron（一次性或变更后）

```powershell
cd d:\Docker\project\cs-main\mail-guide-ai-main\scripts\selfhosted
.\Apply-VaultAndCron.ps1
```

详情与验证 SQL 见 `self-hosted-supabase.md`。

---

## 八、可选：手动触发收信同步（一般不必）

若未配置 pg_cron，可用 Service Role 调 `sync-mailbox`（URL 与密钥换成你的环境）：

```powershell
$supabaseUrl = "https://你的Kong或API基址"
$key = "YOUR_SERVICE_ROLE_KEY"

Invoke-RestMethod -Method Post -Uri "$supabaseUrl/functions/v1/sync-mailbox" `
  -Headers @{ Authorization = "Bearer $key"; apikey = $key; "Content-Type" = "application/json" } `
  -Body '{}'
```

已配置「约每 5 分钟自动同步」时，通常只需保证 **Functions 已部署** 与 **`.env.functions` 正确**，无需每次手调。
