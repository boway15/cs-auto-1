# 发布漏项与集中验收 — 运维说明

## 是不是运维发布时少发了东西？

**基本是。** 当前架构把交付物拆在多处，只部署其中一块就会「栈在跑、业务报错」：

| 漏项 | 典型现象 | 文档 |
|------|----------|------|
| 未同步 Edge Functions | `entrypoint`、`test-mailbox` 失败 | [`ops-sync-edge-functions-on-production.md`](./ops-sync-edge-functions-on-production.md) |
| 服务器只有 `supabase-selfhost`，无 `mail-guide-ai-main` | sync 脚本报 `/data/supabase/functions` 不存在 | 同上 |
| 前端镜像构建用了本机 `VITE_*` | 注册进研发库、连错 Kong | [`ops-fix-production-image-wrong-supabase.md`](./ops-fix-production-image-wrong-supabase.md) |
| 未跑 SQL 迁移 | 缺表、登录/查询失败 | [`ops-handbook-selfhosted-supabase-centos.md`](./ops-handbook-selfhosted-supabase-centos.md) §4.1 |
| 未跑 vault/cron 脚本 | 定时收信/草稿不跑，或仍打 `*.supabase.co` | 同上 §4.2 |
| 未配置或未重建 `.env.functions` | Dify/ERP/邮件相关函数失败 | [`docker-deploy-new-server.md`](./docker-deploy-new-server.md) §六 |

**不是** Supabase 安装坏了，而是 **发布清单未按变更类型逐项做完**。

---

## 同样的问题会不会在别处出现？

**会。** 凡是依赖 **Edge Function** 的功能，未同步时都会报同类 **`entrypoint`** 错误，只是页面不同：

| 功能 | 函数名 | 页面/触发 |
|------|--------|-----------|
| 邮箱测试连接 | `test-mailbox` | 邮箱配置 |
| 收信 / 同步邮箱 | `sync-mailbox` | 工作台、定时任务 |
| 处理邮件 / 草稿 | `process-email`、`generate-draft` | 工作台 |
| 发回复 | `send-reply` | 工作台 |
| 风险拦截 | `risk-intercept` | 工作台 |
| 订单查询 | `get-order-by-email` | ERP 相关 |
| Dify 回调 | `dify-gateway` | Dify 工作流 |

前端连错 Supabase 时，**所有** 接口都会连到错误环境，不限于邮箱。

---

## 发布时应带的完整清单（按变更选做）

日常发版前先 `git pull`，再按研发说明选行执行：

| 变更类型 | 运维动作 |
|----------|----------|
| 新 SQL | `db push` / 迁移脚本 |
| 新/改 Functions | `sync-functions-to-selfhost.sh` + 重建 `functions` |
| 改 `.env.functions` | 重建 `functions` |
| 改前端 / `VITE_*` | **重新 build 镜像** 并替换容器 |
| 改 Kong/Auth 地址 | 改 `supabase-selfhost/.env` + 重启相关服务 |
| 首次或怀疑 cron | `apply-vault-and-cron.sh` |

详细分步见 [`ops-handbook-selfhosted-supabase-centos.md`](./ops-handbook-selfhosted-supabase-centos.md) **第五节「日常发版」**。

---

## 集中检查一遍（推荐）

发版或交接后，在服务器执行 **一条验收脚本**（需已拉完整仓库）：

```bash
export REPO_ROOT=/data/service/cs-main          # 按实际
export SELFHOST_ROOT=/data/service/supabase-selfhost
export FRONTEND_CONTAINER=intelligent_customer_service   # 可选，检查镜像是否含 localhost

bash "$REPO_ROOT/mail-guide-ai-main/scripts/linux/post-deploy-verify.sh"
```

脚本会检查：

1. `mail-guide-ai-main/supabase/functions` 是否存在  
2. `volumes/functions` 是否与源码对齐（含 `test-mailbox` 等）  
3. `supabase-kong` / `supabase-edge-functions` / `supabase-db` 是否 Up  
4. `hello`、`test-mailbox` 经 Kong 是否非 entrypoint 错误  
5. `.env.functions` 是否存在、关键项是否已填  
6. （可选）前端容器 JS 是否误含 `localhost`  

**退出码 0** = 通过；**非 0** = 按终端 `[FAIL]` 项对照上表文档处理。

人工打勾清单（密钥、Dify、ERP 等）仍见 [`docker-deploy-new-server.md`](./docker-deploy-new-server.md) **第六节**。

---

## 给研发/CI 的建议

发版说明中写清 **变更类型**（SQL / Functions / 前端 / 环境变量），避免运维只拉镜像或只重启 Supabase。  
每次上线附带：`post-deploy-verify.sh` 通过截图或日志。
