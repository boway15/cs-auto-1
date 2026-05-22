# 后端自动化发版流程（Jenkins / 自建 Supabase）

适用范围：`mail-guide-ai-main` 后端，即自建 Supabase 的 **Edge Functions + migrations + vault/pg_cron**。前端镜像发布仍走独立前端 Pipeline。

## 一、固定原则

1. 后端没有单独编译产物；业务 API 是 `mail-guide-ai-main/supabase/functions/` 下的 Edge Functions。
2. 线上真正加载的是 `supabase-selfhost/volumes/functions/`。
3. `hello`、`main` 为自建 Supabase 模板入口，发布时保留不动。
4. 其它业务函数目录按整目录发布：先删除线上旧目录，再复制本次目录。
5. 数据库只执行「本次新增」SQL，不全量重跑 `supabase/migrations/`。
6. cron/vault 变更时执行 `apply-vault-and-cron.sh`；该脚本幂等，可重复运行。

## 二、每次发版只维护一个清单

清单文件：

```text
mail-guide-ai-main/deploy/backend-release.env
```

示例：

```bash
RELEASE_VERSION="v1.0.1"

MIGRATIONS=(
  "20260520120000_automation_12h_twenty_compensation_retries.sql"
)

RUN_APPLY_VAULT_AND_CRON="true"
APPLY_FUNCTIONS="true"
BACKUP_FUNCTIONS="true"
```

维护规则：

| 场景 | 清单怎么写 |
|------|------------|
| 有新数据库变更 | 把本次新增的 `.sql` 文件名写进 `MIGRATIONS` |
| 无数据库变更 | `MIGRATIONS=()` |
| cron / vault / 定时策略有变 | `RUN_APPLY_VAULT_AND_CRON="true"` |
| cron 无变化 | `RUN_APPLY_VAULT_AND_CRON="false"` |
| 常规后端发版 | `APPLY_FUNCTIONS="true"` |

## 三、线上统一执行脚本

脚本：

```text
mail-guide-ai-main/scripts/linux/selfhosted/apply-backend-release.sh
```

Jenkins 在把 `scripts/`、`supabase/`、`deploy/` 同步到线上暂存目录后，只需调用：

```bash
bash /data/temp/mail-guide-ai-main/scripts/linux/selfhosted/apply-backend-release.sh \
  /data/temp/mail-guide-ai-main \
  /data/service/supabase-selfhost \
  /data/temp/mail-guide-ai-main/deploy/backend-release.env
```

脚本会按固定顺序执行：

1. 确认 db 可用。
2. 创建 `ops.backend_release_migrations` 记录表。
3. 只执行清单中列出的、且未记录过的 migration。
4. 按清单决定是否执行 `apply-vault-and-cron.sh`。
5. 备份当前 `volumes/functions/`。
6. 同步业务 Edge Functions（保留 `hello`、`main`）。
7. 重建 `functions` 容器并输出最近日志。

## 四、Jenkins 后端 Pipeline 建议

现有 rsync 阶段需要多同步一个 `deploy/`：

```bash
rsync -avP --delete --password-file=/etc/rsync.bigdata.pass \
  $WORKSPACE/mail-guide-ai-main/scripts/ \
  bigdata@172.16.2.13::aojie_ics/mail-guide-ai-main/scripts/

rsync -avP --delete --password-file=/etc/rsync.bigdata.pass \
  $WORKSPACE/mail-guide-ai-main/supabase/ \
  bigdata@172.16.2.13::aojie_ics/mail-guide-ai-main/supabase/

rsync -avP --delete --password-file=/etc/rsync.bigdata.pass \
  $WORKSPACE/mail-guide-ai-main/deploy/ \
  bigdata@172.16.2.13::aojie_ics/mail-guide-ai-main/deploy/
```

线上发布阶段建议替换为：

```bash
chmod +x /data/temp/mail-guide-ai-main/scripts/linux/selfhosted/*.sh \
         /data/temp/mail-guide-ai-main/scripts/linux/*.sh

bash /data/temp/mail-guide-ai-main/scripts/linux/selfhosted/apply-backend-release.sh \
  /data/temp/mail-guide-ai-main \
  /data/service/supabase-selfhost \
  /data/temp/mail-guide-ai-main/deploy/backend-release.env
```

这样 SQL、cron、Functions 都由同一个脚本处理，不再手动挑 SQL 或手动跑脚本。

## 五、发版验收

```bash
cd /data/service/supabase-selfhost

docker compose ps functions db

docker compose exec -T db psql -U postgres -d postgres -c \
  "SELECT filename, release_version, applied_at FROM ops.backend_release_migrations ORDER BY applied_at DESC LIMIT 10;"

docker compose exec -T db psql -U postgres -d postgres -c \
  "SELECT jobname, schedule FROM cron.job ORDER BY jobname;"

docker compose logs functions --tail 50
```

预期：

- 本次 SQL 出现在 `ops.backend_release_migrations`。
- cron 中有 4 条业务任务，无 `compensating-alerts-every-30min`。
- `functions` 容器正常启动，无明显 502 / env 缺失错误。
