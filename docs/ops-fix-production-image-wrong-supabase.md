# 线上仍连本机库 — 原因与修复（预制镜像 + Linux）

**场景**：生产机 `centos7-2-13` 上 Supabase 栈已运行，但用户注册数据仍出现在研发本机库。  
**实际部署**（以 `docker ps` 为准）：

| 组件 | 容器/镜像 | 端口 |
|------|-----------|------|
| Supabase 自建栈 | `supabase-kong` 等 | **8000**（Kong） |
| 业务前端 | `dockerhub.bestwo.net:4443/aojie_intelligent/intelligent_customer_service:25` | **3010→80** |

**路径示例**：`/opt/cs-main`（按服务器实际路径替换）

---

## 最可能的问题（优先排查）

**结论：线上正在跑的前端镜像 `intelligent_customer_service:25` 在构建时，把本地 Supabase 地址/key 写进了静态 JS；不是业务源码里手写死了路径。**

| 现象 | 说明 |
|------|------|
| 线上 `curl` Kong 健康检查 **200** | 只说明 **Supabase/Kong 正常**，不能说明前端连对了 |
| 用户仍进本机库 | 浏览器请求的是 **镜像里构建进去的 `VITE_*`**，不是服务器上现改的 `.env` |

### 源码侧（仓库内）

前端统一读环境变量，**没有**在 `src/` 里写死 `localhost`：

- `src/lib/supabase.ts`、`src/integrations/supabase/client.ts` → `import.meta.env.VITE_SUPABASE_URL`
- `src/lib/invoke-get-order-by-email.ts` → 同上

但 `mail-guide-ai-main/Dockerfile` 在 **`docker build` 时** 会把 `VITE_*` 打进 `dist/assets/*.js`，运行时 **无法** 通过改服务器 `.env` 覆盖。

### 常见构建误用

若 CI/本机构建时使用了 **`mail-guide-ai-main/.env`**（仍为 `localhost:8000`）或 **`docker-compose.local.yml`**（写死 `http://localhost:8080` 等），线上 `:25` 镜像即会连错环境。

**现网只改 `supabase-selfhost/.env` 或服务器上的 `mail-guide-ai-main/.env` 而不重建镜像 → 对 `:25` 无效。**

### 一步确认（生产机必做）

```bash
docker exec intelligent_customer_service sh -c \
  'grep -oE "https?://[^\"'\'' ]+" /usr/share/nginx/html/assets/*.js 2>/dev/null | sort -u | head -50'
```

若输出含 `localhost`、`127.0.0.1`、研发机 IP、ngrok，或 **没有** `http://172.16.2.13:8000`（与线上 `SUPABASE_PUBLIC_URL` 一致），即证实需 **重建并发布新镜像**（如 `:26`）。

---

## 一、问题原因（详）

### 1. 根本原因：前端镜像构建时写死了错误的 Supabase 地址

若构建 `intelligent_customer_service:25` 时使用了：

```env
VITE_SUPABASE_URL=http://localhost:8000
# 或研发机内网 IP、ngrok 等
VITE_SUPABASE_PUBLISHABLE_KEY=<本机 ANON_KEY>
```

则访问 `http://<服务器>:3010` 的用户，浏览器 JS 仍向 **错误地址** 发注册/登录，数据进入 **研发本机 Postgres**，而不是生产机 `supabase-db`。

### 2. 为何只改服务器 `mail-guide-ai-main/.env` 无效

线上 `docker ps` 中 **没有** 在 8080 运行 `mail-guide-ai` 容器，而是私服镜像 **`intelligent_customer_service:25`**。

- 仅改服务器仓库里的 `mail-guide-ai-main/.env` **不会** 改变已运行镜像内的 `VITE_*`；
- 必须 **用正确参数重新构建镜像** 并 **替换** 容器（如 `:26`）。

### 3. 线上 Supabase 栈本身通常无问题

`supabase-kong` 监听 `0.0.0.0:8000`，`supabase-db`、`auth`、`functions` 正常时，问题在 **前端镜像与线上 Kong 未对齐**。

示例（生产机已验证通过）：

```bash
grep '^SUPABASE_PUBLIC_URL=' .env   # 如 http://172.16.2.13:8000
ANON=$(grep '^ANON_KEY=' .env | cut -d= -f2-)
curl -s -o /dev/null -w "%{http_code}\n" -H "apikey: $ANON" "http://127.0.0.1:8000/auth/v1/health"
# 期望 200 — 仅表示后端 OK，不代表前端已对齐
```

### 4. Kong 报错（若曾误配）

若在 `supabase-selfhost/.env` 将 `SUPABASE_PUBLISHABLE_KEY` 设为与 `ANON_KEY` 相同，Kong 报：

`keyauth_credentials ... already declared`

未执行 `add-new-auth-keys.sh` 时，`SUPABASE_PUBLISHABLE_KEY` 必须 **留空**；前端 `VITE_SUPABASE_PUBLISHABLE_KEY` 填 **`ANON_KEY`**，不是 `SUPABASE_PUBLISHABLE_KEY`。

---

## 二、修改步骤（Linux 运维）

### 步骤 0：确认问题在镜像内（必做）

见上文「一步确认」`docker exec … grep`。

---

### 步骤 1：修正 `supabase-selfhost/.env`

```bash
cd /opt/cs-main/supabase-selfhost
vi .env
```

| 变量 | 要求 |
|------|------|
| `SUPABASE_PUBLIC_URL` | `http://<生产机IP或域名>:8000` 或 HTTPS API 域名 |
| `API_EXTERNAL_URL` | 与 `SUPABASE_PUBLIC_URL` **相同** |
| `SITE_URL` | 用户打开前端的地址，如 `http://<生产机IP或域名>:3010` |
| `SUPABASE_PUBLISHABLE_KEY` | **留空** |
| `ANON_KEY` | **不要改**（除非研发要求轮换密钥） |

```bash
grep '^SUPABASE_PUBLIC_URL=' .env
grep '^ANON_KEY=' .env
```

```bash
docker compose up -d
docker compose up -d --force-recreate kong
docker compose logs kong --tail 20
```

```bash
ANON=$(grep '^ANON_KEY=' .env | cut -d= -f2-)
curl -s -o /dev/null -w "%{http_code}\n" -H "apikey: $ANON" "http://127.0.0.1:8000/auth/v1/health"
```

---

### 步骤 2：用正确参数重新构建前端镜像

在 **CI 或构建机** 使用步骤 1 的 **线上** 值（勿用本机 `localhost`）：

```env
VITE_SUPABASE_URL=http://172.16.2.13:8000
VITE_SUPABASE_PUBLISHABLE_KEY=<线上 ANON_KEY>
VITE_SUPABASE_PROJECT_ID=self-hosted
```

**禁止** 使用 `docker-compose.local.yml` 或本机 `mail-guide-ai-main/.env` 中的 `localhost` 配置参与生产构建。

#### 基于本仓库 `mail-guide-ai-main/Dockerfile`

```bash
cd /path/to/cs-main/mail-guide-ai-main

cat > .env << 'EOF'
VITE_SUPABASE_URL=http://<生产机IP或域名>:8000
VITE_SUPABASE_PUBLISHABLE_KEY=<线上ANON_KEY>
VITE_SUPABASE_PROJECT_ID=self-hosted
EOF

docker compose build --no-cache

docker tag mail-guide-ai:latest \
  dockerhub.bestwo.net:4443/aojie_intelligent/intelligent_customer_service:26
docker push dockerhub.bestwo.net:4443/aojie_intelligent/intelligent_customer_service:26
```

#### 或沿用现有 CI

构建 `intelligent_customer_service` 时注入上述三个 `VITE_*` / `build-arg`。

---

### 步骤 3：在生产机替换容器

```bash
docker pull dockerhub.bestwo.net:4443/aojie_intelligent/intelligent_customer_service:26

docker stop intelligent_customer_service
docker rm intelligent_customer_service

docker run -d \
  --name intelligent_customer_service \
  -p 3010:80 \
  --restart unless-stopped \
  dockerhub.bestwo.net:4443/aojie_intelligent/intelligent_customer_service:26
```

（`docker run` 参数与现网 `:25` 保持一致，仅改 tag。）

---

### 步骤 4：验收

```bash
docker exec intelligent_customer_service sh -c \
  'grep -l localhost /usr/share/nginx/html/assets/*.js 2>/dev/null || echo OK_NO_LOCALHOST'
```

- 浏览器打开 `http://<生产机>:3010` 注册测试；F12 → Network 请求 Host 应为 **172.16.2.13:8000**（或线上 API 域名），不是 `localhost`。
- 新用户只在 **生产** Studio（`:8000`）出现；**研发本机** Studio 不应出现。

---

## 三、分工说明

| 角色 | 事项 |
|------|------|
| **运维** | 修正 `supabase-selfhost/.env`；重启 Kong；`docker exec grep` 确认镜像；拉取/部署新前端镜像 |
| **研发/CI** | 生产构建注入正确 `VITE_*`；**不要**用 `docker-compose.local.yml` 打生产镜像 |

---

## 四、常见误区

| 误区 | 说明 |
|------|------|
| 只改服务器 `.env` 不 rebuild | 对 `:25` 镜像 **无效** |
| `curl` Kong 200 就认为前端已修好 | 只验证后端；须查镜像内 JS |
| 用 `docker-compose.local.yml` 构建生产镜像 | 会写入 `localhost:8080` 等 |
| `SUPABASE_PUBLISHABLE_KEY` 填成 `ANON_KEY` | Kong 无法启动 |
| `SITE_URL` 仍写 `:8080` | 现网前端在 **3010** |

---

## 五、架构对照

**正确：**

```
用户浏览器 → http://生产机:3010  (intelligent_customer_service)
                    ↓ VITE_SUPABASE_URL
              http://生产机:8000  (supabase-kong) → supabase-db
```

**错误（修复前）：**

```
用户浏览器 → :3010 镜像内 VITE_* → localhost / 研发机:8000 → 研发本机库
```

---

*适用于 `intelligent_customer_service` 私服镜像 + 服务器自建 Supabase（legacy `ANON_KEY` 模式）。*
