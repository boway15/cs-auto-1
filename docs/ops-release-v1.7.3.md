# mail-guide-ai v1.7.3 上线说明（请运维按序执行）

> 研发发版文档 · 对应 `RELEASE_VERSION=v1.7.3` · 模板见 `docs/ops-release-notice-template.md`

**发版类型**：v1.7.2 → **v1.7.3**  
**代码分支**：GitLab `main`  
**提交号**：`e678482f65c3b58b978776d403ef6e3feabfa40f`  
**建议顺序**：同步代码 → 后端脚本（仅 Functions）→ 环境变量（跳过）→ 前端（跳过）→ 验收（直调 repair_full）

---

## 本次上线内容

| 版本/范围 | 主要变化 |
|-----------|----------|
| **v1.7.3 后端** | 附件补拉：有 BODYSTRUCTURE part 时禁止整封回退（防 `WorkerRequestCancelled`）；part 按 encoding 直接解码；worker 复核 `storage_path` 后才 `resolved`；回收僵死 `running` |
| **数据库** | 无新增 migration |

---

## 研发需单独提供（不进 Git）

| 材料 | 用途 |
|------|------|
| 无新增密钥 | 本版不改 `.env.functions` 必填项 |

**发版清单** `mail-guide-ai-main/deploy/backend-release.env` **已在 Git**。

清单要点：

```text
RELEASE_VERSION="v1.7.3"
MIGRATIONS=()
RUN_APPLY_VAULT_AND_CRON="false"
APPLY_FUNCTIONS="true"
BACKUP_FUNCTIONS="true"
```

> **禁止**将 `APPLY_FUNCTIONS` 设为 `false`。本版**无需**前端 Pipeline。

---

## 服务器路径

| 项 | 路径 |
|----|------|
| 发版暂存 | `/data/temp/mail-guide-ai-main` |
| 自建 Supabase | `/data/service/supabase-selfhost` |
| Functions 环境变量 | `/data/service/supabase-selfhost/.env.functions` |

---

## 执行步骤

### 第 1 步：Jenkins 同步代码

同步至 `/data/temp/mail-guide-ai-main/`：`scripts/`、`supabase/`、`deploy/`。勿同步含密钥的 `.env.functions`。

### 第 2 步：执行后端发版脚本

```bash
chmod +x /data/temp/mail-guide-ai-main/scripts/linux/selfhosted/*.sh \
         /data/temp/mail-guide-ai-main/scripts/linux/*.sh

bash /data/temp/mail-guide-ai-main/scripts/linux/selfhosted/apply-backend-release.sh \
  /data/temp/mail-guide-ai-main \
  /data/service/supabase-selfhost \
  /data/temp/mail-guide-ai-main/deploy/backend-release.env
```

### 第 3 步：环境变量

本次跳过。备注：Edge 墙钟硬顶约 150s，单靠调高 `EDGE_WORKER_TIMEOUT_MS` 无法超过 cap；根因已用「禁整封回退」处理。积压很大时可另开工单将 `MAIL_ATTACHMENT_REPAIR_BATCH_LIMIT` 调到 2～3。

### 第 4 步：前端

本次**跳过**。

### 第 5 步：验收

```bash
cd /data/service/supabase-selfhost
docker compose ps functions db
# 应能搜到 part_fetch_or_decode / no_fullbody 相关逻辑或 decodeImapPartPayload
grep -n "part_fetch_or_decode_failed_no_fullbody_fallback\|decodeImapPartPayload\|stale_running_recovered" \
  volumes/functions/sync-mailbox/index.ts \
  volumes/functions/run-email-attachment-repair-tasks/index.ts \
  volumes/functions/_shared/mime-parse.ts \
  volumes/functions/_shared/email-attachment-repair-queue.ts | head -40
```

**业务冒烟（可研发 SQL / 运维配合）** — 对曾失败的邮件（例：`2708b75c-4572-4d63-9859-8ef16acd7b24`）：

```sql
-- 清锁让路并重置该任务
UPDATE email_attachment_repair_tasks
SET next_run_at = now() + interval '1 day'
WHERE status = 'pending'
  AND email_id <> '2708b75c-4572-4d63-9859-8ef16acd7b24';

UPDATE email_attachment_repair_tasks
SET status = 'pending',
    next_run_at = now(),
    locked_at = null,
    locked_by = null,
    last_error = 'post_v173_verify'
WHERE email_id = '2708b75c-4572-4d63-9859-8ef16acd7b24';

SELECT net.http_post(
  url := 'http://kong:8000/functions/v1/sync-mailbox',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (
      SELECT decrypted_secret FROM vault.decrypted_secrets
      WHERE name = 'service_role_key' LIMIT 1
    ),
    'apikey', (
      SELECT decrypted_secret FROM vault.decrypted_secrets
      WHERE name = 'service_role_key' LIMIT 1
    )
  ),
  body := jsonb_build_object(
    'repair_email_id', '2708b75c-4572-4d63-9859-8ef16acd7b24',
    'repair_full', true
  )
) AS request_id;
```

约 1～2 分钟后查：

```sql
SELECT id, status_code, left(content::text, 800)
FROM net._http_response
WHERE id = <request_id>;

SELECT left(attachments::text, 800)
FROM emails
WHERE id = '2708b75c-4572-4d63-9859-8ef16acd7b24';
```

**通过标准**：

| 检查 | 期望 |
|------|------|
| Functions 容器 | Up；grep 命中新逻辑 |
| `_http_response` | **不是** `WorkerRequestCancelled`；宜 `repaired>=1` 或可观测错误（非整封超时） |
| `attachments` | 含 `filename` / `storage_path` |
| 工作台 | 可预览/下载该邮件附件 |

---

## 禁止事项

- 禁止全量重跑 `supabase/migrations/`
- 禁止仅发前端不发 Functions
- 禁止 `APPLY_FUNCTIONS=false`

---

## 异常联系

脚本报错或验收仍 `WorkerRequestCancelled`：保留 `_http_response` 与 `functions` 日志，联系研发。
