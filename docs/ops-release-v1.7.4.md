# mail-guide-ai v1.7.4 上线说明（请运维按序执行）

> 对应 `RELEASE_VERSION=v1.7.4` · 修复附件补拉 Edge CPU 硬杀 / 套娃超时

**发版类型**：v1.7.3 → **v1.7.4**  
**代码分支**：GitLab `main`  
**提交号**：`4f52f3f0385378159b546640ee022bbe8f15819a`  
**建议顺序**：同步代码 → 后端 Functions → **启动 Docker 附件 Worker（推荐）** → 验收

---

## 本次上线内容

| 范围 | 变化 |
|------|------|
| Functions | 附件补拉去 HTTP 套娃；每轮少 part + 45s 续传；取消类错误拉长 `next_run_at` |
| 脚本 | `apply-backend-release.sh` 兼容 CentOS7 空 `MIGRATIONS=()` |
| Worker | 新增 `email-attachment-repair-worker`（强烈建议生产启） |
| SQL | 无 |

清单要点：

```text
RELEASE_VERSION="v1.7.4"
MIGRATIONS=()
APPLY_FUNCTIONS="true"
RUN_APPLY_VAULT_AND_CRON="false"
```

---

## 执行步骤

### 1）Jenkins 同步

rsync `scripts/`、`supabase/`、`deploy/` → `/data/temp/mail-guide-ai-main/`

### 2）后端发版

```bash
bash /data/temp/mail-guide-ai-main/scripts/linux/selfhosted/apply-backend-release.sh \
  /data/temp/mail-guide-ai-main \
  /data/service/supabase-selfhost \
  /data/temp/mail-guide-ai-main/deploy/backend-release.env
```

若仍报 `MIGRATIONS[@]: unbound variable`：确认 temp 里脚本已含  
`for migration in ${MIGRATIONS[@]+"${MIGRATIONS[@]}"}`（本版已修）。

### 3）启动 Docker 附件 Worker（生产推荐）

在可访问 Kong / DB 的机器上（路径按现网调整）。若 Worker 与 supabase 同一 Docker 网络：

```bash
cd /data/temp/mail-guide-ai-main   # 或 /data/service/cs-main/mail-guide-ai-main
# 生产请把 SUPABASE_URL 指到 kong（示例）
export SUPABASE_URL=http://kong:8000   # 或宿主机可达的 Kong
docker compose -f docker-compose.worker.yml up -d email-attachment-repair-worker
docker compose -f docker-compose.worker.yml logs -f --tail 50 email-attachment-repair-worker
```

说明：`docker-compose.worker.yml` 默认 `host.docker.internal:8000` 适合本机联调；**现网务必改为可达的 Kong 地址**，并把 `SERVICE_ROLE_KEY` 注入（通常来自 `.env` / `.env.functions`）。

### 4）验收问题邮件

```sql
UPDATE email_attachment_repair_tasks
SET status = 'pending',
    next_run_at = now(),
    locked_at = null,
    locked_by = null,
    last_error = 'post_v174_verify',
    attempt_count = 0
WHERE email_id = '2708b75c-4572-4d63-9859-8ef16acd7b24';
```

等 Docker Worker 或 cron 跑数轮（每轮约 1～2 个附件，共 3 个约数分钟）后：

```sql
SELECT left(attachments::text, 800) FROM emails
WHERE id = '2708b75c-4572-4d63-9859-8ef16acd7b24';

SELECT status, attempt_count, last_error, next_run_at
FROM email_attachment_repair_tasks
WHERE email_id = '2708b75c-4572-4d63-9859-8ef16acd7b24';
```

**通过**：`attachments` 含 `storage_path`；任务 `resolved`。

可选：Edge 限额仍建议保持  
`EDGE_CPU_TIME_HARD_LIMIT_MS=120000`、`EDGE_WORKER_TIMEOUT_MS=150000`（改 `.env.functions` 后重建 functions）。

---

## 禁止事项

- 禁止只发前端  
- 禁止 `APPLY_FUNCTIONS=false`  
- 未启 Docker Worker 时，Edge 仍可能偶发 CPU 硬杀；生产应启 Worker  
