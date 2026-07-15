---
name: mail-guide-ai-ops
description: "处理 mail-guide-ai 生产运维、Jenkins 发布、自建 Supabase 后端发版、Edge Functions、Docker 附件/正文 Worker、migrations、pg_cron、.env.functions、CentOS 排障（含 fetch failed、待补拉附件）。用户提到运维、上线、发版、Pipeline、Jenkins、CentOS、functions、Worker、附件补拉、SQL、cron、Supabase 自建部署时使用。提交/发版清单核对请优先 /mail-guide-ops 或 cs-main-ops-role。"
---

# mail-guide-ai 运维发版

> **提交与发版清单**：优先使用 Cursor 子代理 **`/mail-guide-ops`** 或技能 `cs-main-ops-role`（见 `docs/ops-role-quickstart.md`）。下文为发版技术细节。

## 固定认知

- 项目后端没有单独 Java/Node 服务；业务 API 在 Supabase Edge Functions。
- 后端源码目录：`mail-guide-ai-main/supabase/functions/`。
- 线上运行目录：`supabase-selfhost/volumes/functions/`。
- 发布 Functions 时保留 `hello`、`main`，其它业务函数目录整目录替换。
- 数据库只执行本次新增 migration，不能全量重跑 `supabase/migrations/`。
- cron/vault 由 `mail-guide-ai-main/scripts/linux/selfhosted/apply-vault-and-cron.sh` 维护。

## 标准后端发布流程

1. 让研发维护 `mail-guide-ai-main/deploy/backend-release.env`：
   - `MIGRATIONS` 只列本次新增 SQL。
   - 无 SQL 时写 `MIGRATIONS=()`。
   - cron/vault 策略变更时 `RUN_APPLY_VAULT_AND_CRON="true"`。
2. Jenkins 将 `scripts/`、`supabase/`、`deploy/` 同步到线上暂存目录（含 Worker 时加 `docker-compose.worker.yml`）。
3. 线上固定执行：

```bash
bash /data/temp/mail-guide-ai-main/scripts/linux/selfhosted/apply-backend-release.sh \
  /data/temp/mail-guide-ai-main \
  /data/service/supabase-selfhost \
  /data/temp/mail-guide-ai-main/deploy/backend-release.env
```

4. 验收：
   - `docker compose ps functions db`
   - 查询 `ops.backend_release_migrations` 确认本次 SQL 已记录。
   - 查询 `cron.job` 确认定时任务指向自建 Kong。
   - `docker compose logs functions --tail 50` 无明显错误。
   - 若启了附件 Worker：见下文「Docker Worker」验收要点。

## 回答运维问题的口径

- “每次后端都更新 scripts 和 supabase 吗？”
  主要同步 `supabase/functions`；`scripts` 是工具，脚本变更或 Jenkins 固定调用时同步；SQL 和 cron 由 `backend-release.env` 控制。
- “后续也保留 hello/main 吗？”
  是。`hello`、`main` 不动，其它业务函数目录先删后整目录拷贝。
- “SQL 怎么自动化？”
  只把本次新增 SQL 写进 `deploy/backend-release.env`，统一脚本会自动跳过已记录的 SQL。

## Docker Worker（附件/正文补拉，v1.7.4+）

生产「待补拉」大附件：**强烈建议**跑 `email-attachment-repair-worker`，勿长期只靠 Edge cron（易 CPU/墙钟硬杀 → 假 resolved / 一直占位）。

### 配置所在

- 文件：`mail-guide-ai-main/docker-compose.worker.yml`（**URL + 网络写在此文件**，禁止依赖 `/tmp/*-override.yml`）
- 现网默认：`SUPABASE_URL=http://supabase-kong:8000`，外部网络 `supabase_default`
- 覆盖 `.env` 里常见的 `SUPABASE_URL=http://127.0.0.1:8000`（`environment` 优先于 `env_file`）

### 现网最短启动

```bash
# env_file 相对路径是 ../supabase-selfhost；发版在 /data/temp 时做软链（勿复制密钥）
ln -sfn /data/service/supabase-selfhost /data/temp/supabase-selfhost

cd /data/temp/mail-guide-ai-main
docker compose -f docker-compose.worker.yml up -d --force-recreate email-attachment-repair-worker
docker exec mail-guide-email-attachment-repair-worker printenv SUPABASE_URL
# 必须是 http://supabase-kong:8000 ，不能是 127.0.0.1
docker compose -f docker-compose.worker.yml logs --tail 40 email-attachment-repair-worker
```

rsync 须含：`docker-compose.worker.yml`、`scripts/workers/`。

### 踩坑对照（v1.7.4 实战）

| 现象 | 原因 | 处理 |
|------|------|------|
| `env file /data/temp/supabase-selfhost/.env not found` | compose 相对路径在 temp 旁找 sibling | `ln -sfn /data/service/supabase-selfhost /data/temp/supabase-selfhost` |
| `TypeError: fetch failed` 循环 | URL 为 `127.0.0.1` / 未进 Kong 网 / CentOS 上 `host.docker.internal` | yml 用 `supabase-kong:8000` + `networks.supabase_net → supabase_default` |
| `export SUPABASE_URL` 无效 | compose `environment` 写死值不被宿主机 export 覆盖 | 改 `docker-compose.worker.yml` 后 `--force-recreate` |
| 占位符 `docker network connect <实际网络名>` | bash 把 `<>` 当重定向 | 填真实名，现网常见 **`supabase_default`** |
| `processed:0` 一直空 | 无到期任务 | 验收 SQL 把任务改 `pending`、`next_run_at=now()` |
| `mail-ca.pem` NotFound | 沙箱路径读不到文件 | 有 `bundled 163 mail CA` 即可，不挡发版 |

### 验收要点

- 日志：`[att-worker] started`，成功时可见 `{"processed":1,"results":[{"status":"resolved","stored":N}]}`
- DB：`emails.attachments` 含 `storage_path`；`email_attachment_repair_tasks.status=resolved`
- Edge 限额（`.env.functions`，改完 recreate functions）：soft 60s / hard 120s / worker 150s / mem 256 / `MAIL_ATTACHMENT_REPAIR_BATCH_LIMIT=1`

参考发版说明：`docs/ops-release-v1.7.4.md`。清单速查：`cs-main-ops-role`「现网踩坑清单」。

## 本地 Windows：验证单条 migration（非生产）

与线上 `apply-backend-release.sh` 无关；研发在 `supabase-selfhost` 自测时用：

```powershell
docker compose cp "<repo>/mail-guide-ai-main/supabase/migrations/<file>.sql" db:/tmp/mig.sql
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f /tmp/mig.sql
```

- 勿用 PowerShell 管道 `Get-Content | psql` 跑含中文 `COMMENT` 的 SQL
- `db push` 用 **`127.0.0.1:15432`**，密码勿用文档占位符
- 说明：`DEPLOY.md` §六、`mail-guide-ai-main/docs/self-hosted-supabase.md`「四步 / B0」

## 文档入口

- 标准自动化流程：`docs/backend-release-automation.md`
- CentOS 运维手册：`docs/ops-handbook-selfhosted-supabase-centos.md`
- 清单：`mail-guide-ai-main/deploy/backend-release.env`
- 统一脚本：`mail-guide-ai-main/scripts/linux/selfhosted/apply-backend-release.sh`
- Worker compose：`mail-guide-ai-main/docker-compose.worker.yml`
- v1.7.4 运维说明：`docs/ops-release-v1.7.4.md`
