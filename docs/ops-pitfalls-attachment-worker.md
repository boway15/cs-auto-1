# 现网踩坑：附件补拉 Docker Worker（v1.7.4 实战）

> 与 Cursor 技能同步：`cs-main-ops-role`「现网踩坑清单」、`mail-guide-ai-ops`「Docker Worker」。  
> 发版样例：`docs/ops-release-v1.7.4.md`。

## 背景

大附件「待补拉」若只靠 Edge cron，企邮 IMAP 易触达 CPU/墙钟硬杀，占位附件长期无 `storage_path`。v1.7.4 起生产应启 `email-attachment-repair-worker`。

## 踩坑清单

| # | 踩坑 | 正确做法 |
|---|------|----------|
| 1 | 大附件只靠 Edge cron | 启 Docker 附件 Worker |
| 2 | 改 Edge 限额不 recreate | `.env.functions` 改完必须 recreate `functions` |
| 3 | `SUPABASE_URL=http://127.0.0.1:8000` | 容器内指自身 → `fetch failed`；现网用 `http://supabase-kong:8000` |
| 4 | `export SUPABASE_URL=...` | **盖不过** compose 写死的 `environment` |
| 5 | CentOS 用 `host.docker.internal` | Desktop 可用；现网常无效 |
| 6 | `/data/temp` 无 `../supabase-selfhost/.env` | `ln -sfn /data/service/supabase-selfhost /data/temp/supabase-selfhost` |
| 7 | Worker 未进 Kong 网 | 外部网络 `supabase_default`（以 `docker network ls` 为准） |
| 8 | 依赖 `/tmp/*-override.yml` | **禁止**；写进 `docker-compose.worker.yml` |
| 9 | `processed:0` 当失败 | API 已通；无到期任务时正常，验收前重置任务 |
| 10 | `mail-ca.pem` NotFound | 有 `bundled 163 mail CA` 可不挡发版 |

## 现网最短启动

```bash
ln -sfn /data/service/supabase-selfhost /data/temp/supabase-selfhost
cd /data/temp/mail-guide-ai-main
docker compose -f docker-compose.worker.yml up -d --force-recreate email-attachment-repair-worker
docker exec mail-guide-email-attachment-repair-worker printenv SUPABASE_URL
# 期望：http://supabase-kong:8000
```

## `.env.functions` 建议值（附件相关）

```text
EDGE_CPU_TIME_SOFT_LIMIT_MS=60000
EDGE_CPU_TIME_HARD_LIMIT_MS=120000
EDGE_WORKER_TIMEOUT_MS=150000
EDGE_MEMORY_LIMIT_MB=256
MAIL_ATTACHMENT_REPAIR_BATCH_LIMIT=1
```

改完：

```bash
cd /data/service/supabase-selfhost
docker compose up -d --force-recreate --no-deps functions
```

## 验收通过形态

- Worker：`[att-worker] started`，成功时有 `stored:N` / `status: resolved`
- DB：`attachments` 含 `filename` + `storage_path`
- 任务：`email_attachment_repair_tasks.status=resolved`
