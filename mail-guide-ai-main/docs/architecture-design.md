# mail-guide-ai 架构说明（当前 + 未来）

> 状态说明  
> - **当前实现（已落地）**：Supabase Cloud + Edge Functions + 本机 Dify  
> - **未来方案（未落地）**：Node.js 自托管中间层  
> 本文原始内容主要是未来方案，已在文首补充当前基线，避免误读。

---

## 一、当前实现架构（请以此为运行基线）

### 1) 运行组件

- 前端：`mail-guide-ai-main`（React + Vite）
- 认证/数据库/后端能力：Supabase Cloud（Auth + Postgres + Edge Functions）
- AI 工作流：本机 Dify（`d:\Docker\project\cs-main\dify\docker\docker-compose.cs.yml`）
- 对接方式：Supabase Edge Functions 通过 ngrok 公网地址调用 Dify

### 2) 链路

```text
邮件 -> sync-mailbox -> emails
     -> process-email(分析/关联/推荐/风控分流)
     -> generate-draft / auto-template / manual
     -> send-reply / risk-intercept
```

### 3) 关键端口（当前仓库）

- 客服前端：`http://localhost:8080`
- Dify 入口：`http://localhost:8090`

---

## 二、未来自托管方案（规划稿，未落地）

> 说明：以下章节（体量评估、整体架构、Node.js 后端设计、迁移路线）均为目标方案设计，当前仓库尚未包含 `mail-guide-api` 实现。

## 体量评估

| 指标 | 数值 |
|---|---|
| 月均邮件数 | 20,000 ~ 30,000 封 |
| 日均邮件数 | 650 ~ 1,000 封 |
| 平均每分钟 | ~1 封 |
| 客服账号 | 5 ~ 7 个 |
| 一年数据量 | ~36 万封 |

此体量对 PostgreSQL 而言非常轻松，无需分库分表或引入消息队列。

---

## 整体架构（目标）

```
┌──────────────────────────────────────────────────────────┐
│  Nginx Reverse Proxy (80/443)                            │
│  → /api/*        → Node.js Backend :3000                 │
│  → /             → Static Assets (Nginx :8080)            │
│  → /dify/*       → Dify Web :3000                         │
│  → /dify-api/*   → Dify API :5001                         │
└──────────────────────────────────────────────────────────┘
                            │
         ┌──────────────────┼──────────────────┐
         ▼                  ▼                  ▼
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │ Node.js API  │  │React Frontend│  │ Dify 工作流  │
  │ :3000        │  │ Nginx :8080  │  │ Docker Stack │
  │              │  │              │  │ :3000/:5001  │
  │ • JWT 认证   │  │              │  │              │
  │ • REST API   │  │              │  │ • 邮件查询   │
  │ • IMAP 同步  │  │              │  │ • AI 草稿    │
  │ • SMTP 发送  │  │              │  │ • 风控规则   │
  │ • 风控拦截   │  │              │  │              │
  └──────┬───────┘  └──────────────┘  └──────────────┘
         │                                        │
         └──────────┬─────────────────────────────┘
                    ▼
         ┌──────────────────┐
         │   PostgreSQL     │
         │   :5432          │
         │                  │
         │ • mail_guide_db  │
         │ • dify_db        │
         └──────────────────┘
```

---

## Node.js 后端设计（目标）

### 模块划分

```
mail-guide-api/
├── package.json
├── Dockerfile
├── src/
│   ├── index.js                 # 入口
│   ├── config.js                # 配置（数据库连接、JWT 密钥等）
│   ├── db/
│   │   ├── pool.js              # PostgreSQL 连接池
│   │   └── migrate.js           # 启动时自动建表/迁移
│   ├── middleware/
│   │   ├── auth.js              # JWT 验证中间件
│   │   └── cors.js              # CORS
│   ├── routes/
│   │   ├── auth.js              # 登录/注册/用户管理
│   │   ├── emails.js            # 邮件 CRUD
│   │   ├── mailboxes.js         # 邮箱配置 CRUD
│   │   ├── templates.js         # 回复模板 CRUD
│   │   ├── erp.js               # ERP 配置 CRUD
│   │   ├── orders.js            # 订单查询/关联
│   │   └── users.js             # 用户管理
│   ├── services/
│   │   ├── sync-mailbox.js      # IMAP 同步（核心）
│   │   ├── send-reply.js        # SMTP 发送
│   │   ├── process-email.js     # 邮件后处理（AI）
│   │   ├── generate-draft.js    # AI 草稿
│   │   └── risk-intercept.js    # 风控
│   └── utils/
│       ├── imap.js              # IMAP 客户端
│       ├── smtp.js              # SMTP 客户端
│       └── rfc2047.js           # 邮件编码解码
```

### API 端点清单

```
认证
  POST   /api/auth/login          登录
  POST   /api/auth/signup         注册
  POST   /api/auth/logout         退出
  GET    /api/auth/me             当前用户信息

邮件
  GET    /api/emails              邮件列表（分页、筛选、搜索）
  GET    /api/emails/:id          邮件详情
  PATCH  /api/emails/:id          更新状态/指派
  GET    /api/emails/conversation  同往来历史（?from=&to=&exclude=）

邮箱配置
  GET    /api/mailboxes           邮箱列表
  POST   /api/mailboxes           新增邮箱
  PUT    /api/mailboxes/:id       更新邮箱
  DELETE /api/mailboxes/:id       删除邮箱
  POST   /api/mailboxes/test      测试 IMAP 连接

回复模板
  GET    /api/templates           模板列表
  POST   /api/templates           新增模板
  PUT    /api/templates/:id       更新模板
  DELETE /api/templates/:id       删除模板

订单
  GET    /api/orders              订单列表
  POST   /api/emails/:id/link     关联订单
  DELETE /api/emails/:id/unlink   解除关联

AI 操作
  POST   /api/emails/:id/generate-draft  生成回复草稿
  POST   /api/emails/:id/send-reply      发送回复
  POST   /api/emails/:id/risk-intercept  风控处理

同步
  POST   /api/sync                手动触发同步（支持 force_bulk）
  GET    /api/sync/status         同步状态

用户管理
  GET    /api/users               用户列表
  POST   /api/users               创建用户
  PATCH  /api/users/:id/role      修改角色
  DELETE /api/users/:id           删除用户
```

---

## IMAP 同步设计（30K/月适配）

### 首次全量同步策略

首次部署时需同步近 30 天邮件（约 5,000 封/账号）。

**参数配置：**

```
PER_ROUND    = 50      # 每轮处理50封
MAX_ROUNDS   = 40      # 每次同步最多40轮
TIME_BUDGET  = 120s    # 每次同步时间预算
CRON_INTERVAL = 5min   # 每5分钟触发一次
```

**首次同步耗时估算（5,000 封/账号 × 7 账号）：**

| 阶段 | 时间 |
|---|---|
| 单次同步处理 | 50 封 × 40 轮 = 2,000 封 |
| 一个账号扫完 | 5,000 / 2,000 = 3 次调用 |
| 7 个账号扫完 | 3 × 7 = 21 次调用 |
| 总耗时 | 21 × 5min = ~105 分钟 |

首次全量同步约 **2 小时内完成**。

### 增量同步

后续每天约 700-1,000 封新邮件，每次 cron 触发仅同步上次同步以来的增量：

```
每次增量 ≈ 700 / (24h × 60min / 5min) ≈ 2-3 封
```

几乎瞬时完成。

### 去重机制

```
Phase 2: 用 message_id 查重（message_id 有 UNIQUE 约束）
Phase 3: 跳过已存在的，只 insert 新邮件
```

---

## 数据库设计

### emails 表索引

```sql
-- 已有的
CREATE INDEX idx_emails_status ON emails(status);
CREATE INDEX idx_emails_received ON emails(received_at DESC);

-- 按需补充
CREATE INDEX idx_emails_mailbox_id ON emails(mailbox_id);
CREATE INDEX idx_emails_from_email ON emails(from_email);
CREATE INDEX idx_emails_to_email ON emails(to_email);
CREATE INDEX idx_emails_mailbox_received ON emails(mailbox_id, received_at DESC);
```

### 连接池配置

```js
// 30K/月体量，5-10 个连接足够
{
  max: 10,           // 最大连接数
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
}
```

### 分页

所有列表接口使用 **cursor-based pagination**（基于 `received_at DESC`），避免 OFFSET 在大数据量下变慢：

```sql
-- 第一页
SELECT * FROM emails WHERE mailbox_id = $1
ORDER BY received_at DESC LIMIT 20;

-- 下一页（传上一页最后一条的 received_at）
SELECT * FROM emails WHERE mailbox_id = $1
  AND received_at < $2
ORDER BY received_at DESC LIMIT 20;
```

---

## Docker Compose 全栈（目标）

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: mailguide
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: mail_guide
    volumes:
      - ./volumes/postgres:/var/lib/postgresql/data
      - ./init-schema.sql:/docker-entrypoint-initdb.d/01-schema.sql
    ports:
      - "5432:5432"
    healthcheck:
      test: pg_isready -U mailguide
      interval: 5s

  mail-guide-api:
    build: ./mail-guide-api
    environment:
      DB_HOST: postgres
      DB_PORT: 5432
      DB_USER: mailguide
      DB_PASSWORD: ${DB_PASSWORD}
      DB_NAME: mail_guide
      JWT_SECRET: ${JWT_SECRET}
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "3000:3000"
    restart: unless-stopped

  mail-guide-web:
    image: mail-guide-ai:latest
    build:
      context: ./mail-guide-ai-main
      args:
        API_URL: /api
    ports:
      - "8080:80"
    depends_on:
      - mail-guide-api
    restart: unless-stopped

  dify-*:
    # Dify 原有 Docker 编排不变，数据库指向上面 postgres 的 dify 库
    ...
```

---

## Dify 集成

当前系统已有 Dify 工作流 (`mail-ai-query.yml`)，后端通过 Dify API 调用：

```
发邮件 → IMAP 同步 → 入库
           ↓
    process-email（调用 Dify API 做邮件分类/实体提取）
           ↓
    客服工单 → 点击"生成草稿"
           ↓
    generate-draft（调用 Dify API 生成回复草稿）
           ↓
    客服审核 → 点击"发送"
           ↓
    send-reply（SMTP 发出）
```

Dify 工作流的使用场景：
- **邮件分析**：提取订单号、客户意向、情绪等
- **草稿生成**：根据邮件内容和订单上下文生成回复
- **风控规则**：高风险订单自动拦截

---

## 部署步骤概要（目标）

```
1. 服务器安装 Docker + Docker Compose
2. git clone 本项目
3. 复制 .env.example → .env，填好配置
4. docker compose up -d
5. 访问 http://yourserver:8080
```

---

## 备份策略

```bash
# 每日备份
0 2 * * * pg_dump -U mailguide mail_guide | gzip > /backups/daily/mail_guide_$(date +%Y%m%d).sql.gz

# 清理 30 天前的备份
0 3 * * * find /backups/daily -mtime +30 -delete
```

---

## 性能预估（30K/月体量）

| 指标 | 预期 |
|---|---|
| PostgreSQL 数据量/年 | ~3GB |
| 单页查询响应 | < 50ms |
| 单次增量同步耗时 | < 3s |
| 单次全量同步耗时（首次） | ~2h |
| 并发客服同时在线 | 5-7 人无压力 |

---

## 迁移路线（目标）

```
Phase 1（1-2天）：搭建 PostgreSQL + 写 Node.js 后端基础框架（auth + 核心 CRUD）
Phase 2（1-2天）：移植 sync-mailbox、send-reply、generate-draft 等服务
Phase 3（1天）：修改前端代码（supabase → api 客户端替换）
Phase 4（0.5天）：部署 Dify + 对接工作流
Phase 5（0.5天）：测试 + 上线
```

合计约 **4-6 人天**的工作量。
