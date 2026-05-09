# 自托管迁移：风险评估 & 可执行计划（规划稿）

> 文档状态：**未来规划，未落地**  
> 当前主路径：**自建 Supabase Docker** + Edge Functions + 本机/内网 Dify（见 `docs/self-hosted-supabase.md`、`docs/customer-service-automation-spec.md` §0）。  
> 本文用于评估“迁移到 Node.js 自托管”路线；文中 **Shopify / 补偿次数** 等若与 `customer-service-automation-spec.md` 冲突，**以 spec §0 为准**。

## 一、可行性结论

**可行，且风险可控。** 所有核心逻辑（IMAP 同步、SMTP 发送、MIME 解析）已有经过验证的 Deno 版本，移植到 Node.js 是语法层面的转化。前端改动是机械性的 `supabase.xxx → api.xxx` 替换。唯一需要从零写的是 JWT 认证模块，但这是标准方案。

---

## 二、风险矩阵

### 🔴 高风险（必须前置解决）

#### R1：现有 Supabase Cloud 数据迁移

| 项目 | 说明 |
|---|---|
| 影响范围 | 邮件、邮箱配置、用户、模板、订单关联等全部数据 |
| 具体风险 | 迁移过程中数据丢失或不一致 |
| 当前状态 | Supabase Cloud 上有历史数据（邮箱配置、用户账号、部分邮件） |
| 缓解措施 | **导出 SQL dump → 导入自托管 PostgreSQL。** 17 个 migration SQL 文件保底，结构可以重建。数据用 Supabase Dashboard 导出 CSV + pg_dump |
| 应对方案 | 先在新库跑完所有 migration 建表，再 `COPY` 导入数据行 |

#### R2：IMAP 直连中国邮箱（超时/被墙）

| 项目 | 说明 |
|---|---|
| 影响范围 | 核心功能——邮件同步 |
| 具体风险 | Supabase Edge Function 运行在 us-west-1，连 163.com 时经常挂（你已遇到 EarlyDrop） |
| 缓解措施 | 自托管服务器在中国或香港，IMAP 延迟从 5 秒降到 < 1 秒 |
| 影响 | **正面影响**。自托管后此风险会降低而非升高 |

#### R3：服务中断窗口

| 项目 | 说明 |
|---|---|
| 影响范围 | 迁移期间客服不可用 |
| 具体风险 | 切换期间无法处理邮件 |
| 缓解措施 | **双跑并行**。新系统先上线，旧 Supabase Cloud 保留一周作为回退。两边并行同步，确认新系统稳定后再关旧系统 |
| 预计中断 | 前端切 DNS 时可能中断 5-10 分钟 |

---

### 🟡 中风险（可控，需关注）

#### R4：认证系统重建

| 项目 | 说明 |
|---|---|
| 影响范围 | 所有用户需重新登录 |
| 具体风险 | JWT 实现不当导致安全漏洞（token 泄露、过期策略不合理） |
| 当前用户数 | < 10 个客服账号，影响范围极小 |
| 缓解措施 | 使用成熟的 `jsonwebtoken` 库 + bcrypt 密码哈希。首次启动时创建默认 admin 账号。旧的 Supabase 用户密码不可导出（由 GoTrue 哈希），需要重新设置密码 |
| 处理方式 | 提前通知用户，迁移后发新密码或自行设置 |

#### R5：IMAP/SMTP 代码移植

| 项目 | 说明 |
|---|---|
| 影响范围 | sync-mailbox、send-reply、test-mailbox |
| 具体风险 | Deno API → Node.js API 转换时引入 bug |
| 当前代码量 | sync-mailbox 约 600 行, send-reply 约 130 行, test-mailbox 较短 |
| 缓解措施 | Deno 和 Node.js 的 TCP/TLS API 非常相似。`Deno.connectTls()` → `tls.connect()`，`TextDecoder` → 完全一样。移植主要是 import 路径和 runloop 的改动 |
| 测试策略 | 先用测试邮箱跑完整同步流程，与 Supabase 版本的日志对比 |

#### R6：Dify 数据库依赖

| 项目 | 说明 |
|---|---|
| 具体风险 | Dify Docker compose 自带 PostgreSQL，与自托管 PostgreSQL 冲突 |
| 缓解措施 | 让 Dify 使用独立的 PostgreSQL 容器（它本来就有），邮件系统也用自己的库。共用一个 PostgreSQL 实例的两个 database |
| 影响 | 低。两个系统各用各的 database，互不干扰 |

---

### 🟢 低风险（正常处理即可）

| 风险 | 影响 | 说明 |
|---|---|---|
| R7: 前端 API 替换遗漏 | 功能报错 | 用 grep 全局搜索 `supabase.` 确保无遗漏 |
| R8: RLS 安全策略缺失 | 权限失控 | Node.js 后端用中间件做角色检查，比 RLS 更直观 |
| R9: Edge Functions 未全部部署 | AI 功能不可用 | 全部 7 个 function 改为 service 文件 |
| R10: 备份策略缺失 | 数据丢失 | 方案中已包含每日 pg_dump |

---

## 三、详细实施计划

### Phase 1（第 1-2 天）：基础骨架

```
□ 初始化 Node.js 项目（Express + pg + jsonwebtoken + bcrypt）
□ 写 PostgreSQL 连接池配置
□ 执行全部 17 个 migration SQL 建表
□ 写 JWT 认证模块
  □ POST /api/auth/login（邮箱+密码 → JWT token）
  □ POST /api/auth/signup（注册+自动分配角色）
  □ GET  /api/auth/me（token → 用户信息+角色）
  □ 中间件：JWT 验证 + 角色检查（adminOnly）
□ 写核心 CRUD 路由
  □ GET  /api/emails（cursor 分页 + 状态筛选）
  □ GET  /api/emails/:id
  □ PATCH /api/emails/:id
  □ GET  /api/mailboxes
  □ POST /api/mailboxes
  □ PUT  /api/mailboxes/:id
  □ DELETE /api/mailboxes/:id
  □ GET  /api/emails/conversation
□ Dockerfile + docker-compose 集成
```

**可交付物：** 前端能登录、看到邮件列表、配置邮箱。

---

### Phase 2（第 3-4 天）：移植核心服务

```
□ 移植 Deno → Node.js
  □ sync-mailbox    （IMAP 客户端 + 多轮分批同步 + 去重 + BODYSTRUCTURE 解析）
  □ send-reply      （SMTP 客户端 + RFC 2047 编码）
  □ test-mailbox    （IMAP 连接测试）
  □ process-email   （Dify API 调用来做 AI 处理）
  □ generate-draft  （Dify API 调用生成草稿）
  □ risk-intercept  （Dify API 调用做风控）
  □ shopify 相关    （如已废弃可跳过）

□ Node-cron 定时任务
  □ 每 5 分钟自动同步所有启用邮箱
  □ 首次部署自动触发全量同步（force_bulk）

□ 服务层统一错误处理 + 日志
```

**关键预览 —— Deno → Node.js 移植核心差异：**

```
Deno                          Node.js
─────────────────────────────────────────────────
Deno.connectTls({host,port})  tls.connect(port, host)
import "https://esm.sh/..."    npm install supabase/@supabase
Deno.env.get("KEY")            process.env.KEY
EdgeRuntime.waitUntil(fetch)   Promise.allSettled 或不等待
atob / btoa                    Buffer.from().toString('base64')
new TextDecoder(charset)       new TextDecoder(charset)  ← 完全一样
```

**可交付物：** 邮件自动同步、AI 生成草稿、发送回复全链路走通。

---

### Phase 3（第 4-5 天）：前端改造

```
□ 新建 src/lib/api.ts 替换 src/lib/supabase.ts
  □ 封装 fetch() 调用，自动带 JWT token
  □ 保持方法名和原来 supabase.from() 风格一致以降低改动量

□ 逐个文件替换 supabase 调用
  □ Auth.tsx          supabase.auth.signIn → POST /api/auth/login
  □ useAuth.ts        supabase.auth.getSession → GET /api/auth/me
  □ AppLayout.tsx     supabase.auth.signOut → POST /api/auth/logout
  □ Workbench.tsx     supabase.from('emails') → GET /api/emails
  □                  supabase.functions.invoke → POST /api/emails/:id/generate-draft 等
  □ Mailboxes.tsx     supabase.from('mailboxes') → api.mailboxes.*
  □ Templates.tsx     supabase.from('reply_templates') → api.templates.*
  □ Users.tsx         supabase.from('profiles') → api.users.*
  □ Erp.tsx           supabase.from('erp_configs') → api.erp.*
  □ ProtectedRoute    supabase auth check → api /me 状态

□ 删除不再需要的 Supabase 依赖
  □ 移除 @supabase/supabase-js 依赖
  □ 移除 src/integrations/supabase/ 目录
  □ 移除 supabase/ 目录中的 Edge Function 源码（已移植到后端）
```

**可交付物：** 前端去掉 Supabase SDK，完全用自己的 API。

---

### Phase 4（第 5 天）：Dify 对接

```
□ 将 Dify Docker compose 集成到总编排
  □ 确认 Dify 使用独立或共享的 PostgreSQL
  □ 配置 Dify 的 API endpoint 地址

□ 导入 mail-ai-query.yml 工作流到 Dify

□ 后端对接 Dify API
  □ generate-draft → 调用 Dify 邮件处理工作流
  □ process-email → 调用 Dify 邮件分类工作流
  □ risk-intercept → 调用 Dify 风控规则工作流

□ 环境变量配置
  □ DIFY_API_URL → Dify 服务地址
  □ DIFY_API_KEY → Dify 工作流 API Key
```

---

### Phase 5（第 5-6 天）：迁移上线

```
□ 从 Supabase Cloud 导出数据
  □ pg_dump -h elchuqvftkhszbkwgfjp.supabase.co ... → dump.sql
  □ 导入自托管 PostgreSQL
  □ 验证行数一致

□ 通知用户重新设置密码（Supabase GoTrue 密码不可导出）

□ 部署到服务器
  □ docker compose up -d
  □ 确认所有服务 healthy

□ 双跑验证（1-2 天）
  □ 新旧系统同时运行
  □ 对比工作台数据是否一致
  □ 确认同步功能正常

□ 关闭 Supabase Cloud 项目
  □ 保留数据备份
  □ 切 DNS 到新服务器
```

---

## 四、关键决策点

| 决策 | 推荐 | 理由 |
|---|---|---|
| 语言 | **Node.js（TypeScript）** | 前端也是 TS，统一技术栈，IMAP/SMTP 代码移植成本最低 |
| 框架 | **Express** | 简单够用，不需要 Nest.js 的复杂度 |
| 认证 | **JWT（jsonwebtoken + bcrypt）** | 标准方案，前端无需改动认证流程 |
| 定时任务 | **node-cron** | 替代 pg_cron，在服务内部跑，不依赖数据库 |
| 部署 | **Docker Compose 单机** | 30K/月体量不需要 K8s 或 Swarm |
| 是否保留 Supabase Cloud | **作为过渡保留 1 周** | 双跑确保无数据丢失 |

---

## 五、不做的事情（明确排期外）

- ❌ 不引入 Redis（30K/月不需要缓存层）
- ❌ 不引入消息队列（体量不够，process-email 同步调用 Dify 即可）
- ❌ 不迁移 Shopify 集成（代码中已注释掉，暂不恢复）
- ❌ 不做 WebSocket 实时推送（当前是轮询刷新，够用）

---

## 六、工时汇总

```
Phase 1  基础骨架        ████████████░░░░░░░░░░  1.5 天
Phase 2  核心服务移植    ████████████████░░░░░░  2 天
Phase 3  前端改造        ████████░░░░░░░░░░░░░░  1 天
Phase 4  Dify 对接       ░░░░░████░░░░░░░░░░░░░  0.5 天
Phase 5  迁移上线        ░░░░░░███░░░░░░░░░░░░░  0.5 天
────────────────────────────────────────────────
合计                     5.5 人天（实际按 6 天排）
```
