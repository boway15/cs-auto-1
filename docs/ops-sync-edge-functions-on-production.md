# 生产机同步 Edge Functions — 运维说明

适用于：邮箱「测试连接」报 `could not find an appropriate entrypoint`，或执行同步脚本报 `Source functions folder not found`。

**生产路径示例**（按实际替换）：

| 目录 | 示例 |
|------|------|
| Supabase 自建栈 | `/data/service/supabase-selfhost` |
| 完整业务仓库 | `/data/service/cs-main`（须含 `mail-guide-ai-main`） |

---

## 一、测试连接为什么失败

报错：

```json
{"msg":"InvalidWorkerCreation: ... could not find an appropriate entrypoint"}
```

**原因**：`test-mailbox` 等业务函数没有同步到  
`/data/service/supabase-selfhost/volumes/functions/`，容器里找不到入口文件。

**要做的事**：把 `mail-guide-ai-main/supabase/functions/` 同步进 `volumes/functions/`，并重建 `functions` 容器（见第三节）。

---

## 二、同步脚本为什么报错（常见误操作）

若在 **`supabase-selfhost` 目录内**执行：

```bash
cd /data/service/supabase-selfhost
./sync-functions-to-selfhost.sh /data/service/supabase-selfhost
```

会出现：

```text
Source functions folder not found: /data/supabase/functions
```

**原因**：

1. 脚本设计在 **`mail-guide-ai-main/scripts/linux/`** 下运行，源码路径应为  
   `mail-guide-ai-main/supabase/functions`。
2. 脚本放在 `supabase-selfhost` 根目录执行时，会错误推算为 `/data/supabase/functions`（不存在）。
3. 生产机若 **只有** `supabase-selfhost`，没有拉 **`mail-guide-ai-main`** 仓库，也没有函数源码可同步。

**结论**：不能只在 `supabase-selfhost` 里单独跑脚本；必须先有完整仓库（或至少 `mail-guide-ai-main/supabase/functions`）。

---

## 三、正确操作步骤

### 3.1 确认已有业务源码

```bash
ls /data/service/cs-main/mail-guide-ai-main/supabase/functions/test-mailbox/index.ts
```

若无此路径 → 先 `git clone` / `git pull` 完整仓库到服务器（如 `/data/service/cs-main`）。

### 3.2 同步函数（从仓库根目录执行）

```bash
cd /data/service/cs-main
git pull

bash mail-guide-ai-main/scripts/linux/sync-functions-to-selfhost.sh \
  /data/service/supabase-selfhost
```

**不要**在 `supabase-selfhost` 内对复制过来的 `./sync-functions-to-selfhost.sh` 执行。

### 3.3 重建 functions 容器

```bash
cd /data/service/supabase-selfhost
docker compose up -d --force-recreate --no-deps functions
```

### 3.4 验收

```bash
# 磁盘上应有 test-mailbox
ls /data/service/supabase-selfhost/volumes/functions/test-mailbox/index.ts

# 容器内应有
docker exec supabase-edge-functions ls /home/deno/functions/test-mailbox/

# 经 Kong 调用（不应再报 entrypoint）
cd /data/service/supabase-selfhost
ANON=$(grep '^ANON_KEY=' .env | cut -d= -f2-)
curl -s -X POST "http://127.0.0.1:8000/functions/v1/test-mailbox" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "Content-Type: application/json" \
  -d '{"host":"imap.example.com","port":993,"user":"u","pass":"p"}'
```

返回 `{"ok":false,"message":"[connect] …"}` 表示函数已部署成功，后续再排查邮箱/IMAP 配置。

---

## 四、注意

- **不要删除** `volumes/functions/main/`、`hello/`。
- 仓库路径不是 `/data/service/cs-main` 时，把第三节中的路径改成实际路径即可；**脚本始终用** `mail-guide-ai-main/scripts/linux/sync-functions-to-selfhost.sh`。
- 无 git 时，可由研发打包 `mail-guide-ai-main/supabase/functions/` 上传到服务器后，按目录复制到 `volumes/functions/`（跳过 `main`、`hello`），再执行 3.3。
- 前端连错 Supabase（如 `localhost`）见 [`ops-fix-production-image-wrong-supabase.md`](./ops-fix-production-image-wrong-supabase.md)。
- 发版后集中验收见 [`ops-post-deploy-checklist.md`](./ops-post-deploy-checklist.md)（含 `post-deploy-verify.sh`）。
