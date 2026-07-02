# 工作台：发件附件/图片 + 快捷回复模板 — 产品设计规格

**日期**：2026-07-02  
**状态**：已批准（2026-07-02）  
**范围**：`mail-guide-ai-main` 工作台（Workbench）人工回复能力增强

---

## 1. 背景与目标

### 1.1 现状

| 能力 | 现状 |
|------|------|
| 人工回复 | 纯文本 `Textarea` → `send-reply` Edge Function → SMTP 纯文本/HTML |
| 入站附件 | 完整：IMAP 同步 → Storage → 工作台预览/下载/补拉 |
| 出站附件 | **无**：`smtp.ts` 仅 `multipart/alternative` |
| 模板 | `reply_templates` + `/templates` 仅服务**自动化**缺信息回复 |
| 快捷回复 | **无**独立能力 |

### 1.2 目标

1. **发件附件**：客服回复时可上传文件附件（及后续内嵌图片）。
2. **快捷回复**：团队共享模板 + 个人私人模板，工作台一键插入，支持变量替换。

### 1.3 已确认产品决策

- **快捷回复作用域**：**B — 团队 + 个人**
  - 团队模板：管理员 CRUD，全员可见可用
  - 个人模板：各客服 CRUD 自己的模板，仅本人可见

---

## 2. 交付策略

两项功能独立，分迭代交付：

| 迭代 | 功能 | 预估 |
|------|------|------|
| **P1** | 快捷回复模板 | 5–7 天 |
| **P2a** | 发件文件附件 | 5–7 天 |
| **P2b** | 正文内嵌图片（可选） | 3–5 天 |

**理由**：P1 不改 SMTP，风险低、价值快；P2 涉及 MIME 构建与 Storage，复杂度更高。

---

## 3. 功能 A：快捷回复模板

### 3.1 用户故事

- 作为**客服**，我希望从常用话术列表一键插入回复，减少重复打字。
- 作为**管理员**，我希望维护团队标准话术，并按业务意图分类。
- 作为**客服**，我希望保存个人常用语，不影响团队模板。

### 3.2 数据模型

新建表 `quick_reply_templates`（与 `reply_templates` 分离，避免自动/人工语义混杂）：

```sql
CREATE TABLE public.quick_reply_templates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT NOT NULL,
  body_template    TEXT NOT NULL,
  subject_template TEXT,
  category         TEXT,
  business_intents TEXT[] NOT NULL DEFAULT '{}',
  scope            TEXT NOT NULL CHECK (scope IN ('team', 'personal')),
  owner_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  sort_order       INT NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT quick_reply_personal_owner_chk CHECK (
    (scope = 'team' AND owner_id IS NULL) OR
    (scope = 'personal' AND owner_id IS NOT NULL)
  )
);

CREATE INDEX idx_quick_reply_team ON public.quick_reply_templates (scope, is_active, sort_order)
  WHERE scope = 'team';
CREATE INDEX idx_quick_reply_personal ON public.quick_reply_templates (owner_id, is_active, sort_order)
  WHERE scope = 'personal';

CREATE TRIGGER trg_quick_reply_templates_updated
  BEFORE UPDATE ON public.quick_reply_templates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
```

### 3.3 变量占位符

与现有 `process-email` / `Templates.tsx` 的 `renderTemplate` 规则一致：

| 变量 | 说明 |
|------|------|
| `{{from_name}}` | 发件人显示名 |
| `{{from_email}}` | 发件人邮箱 |
| `{{subject}}` | 客户邮件主题 |
| `{{reply_to_email}}` | 实际回复收件人 |
| `{{order_no}}` | 关联订单号（可能为空） |
| `{{missing_elements}}` | 缺失要素 |

**渲染时机**：插入模板时在前端用当前选中邮件上下文渲染；未知键替换为空串（与现网一致）。

### 3.4 权限（RLS）

| 操作 | team 模板 | personal 模板 |
|------|-----------|---------------|
| SELECT | 所有 `authenticated` | `owner_id = auth.uid()` |
| INSERT team | `has_role(uid, 'admin')` | — |
| INSERT personal | — | `owner_id = auth.uid()` |
| UPDATE/DELETE team | admin | — |
| UPDATE/DELETE personal | — | `owner_id = auth.uid()` |

guest 角色沿用现有 `reply_templates` 策略：只读 team 模板（若 guest 可进工作台）。

### 3.5 工作台 UI

**位置**：回复区 `Textarea` 上方工具栏。

**组件行为**：

1. 「快捷回复 ▼」下拉/Popover，分组展示：
   - 按 `category` 分组（团队模板）
   - 「我的模板」分组（personal）
   - 当前邮件 `business_intent` 匹配的模板置顶或高亮
2. 选中模板 → 确认对话框：
   - **追加**到正文末尾
   - **替换**正文
   - 若模板含 `subject_template`：可选「同时更新主题」（需暴露主题编辑或内部 state；`send-reply` 已支持 `subject_override`）
3. 插入后 `replyContent` 更新，用户可继续编辑再发送。

**与 AI 草稿关系**：并列能力，互不覆盖；典型流程为 AI 草稿 → 快捷回复追加 → 发送。

### 3.6 管理页面

**位置**：`/templates` 新增 Tab「快捷回复」（推荐，与自动回复模板同页、语义清晰）。

**团队模板（admin）**：

- CRUD：标题、正文、可选主题、分类、业务意图标签、排序、启用/停用
- 拖拽排序或数字 `sort_order`
- 预览（复用 `applyReplyTemplatePreview` 逻辑）

**个人模板（所有登录用户）**：

- 同 CRUD，scope 固定 `personal`，`owner_id = auth.uid()`
- 普通用户不可编辑 team 模板

### 3.7 API / 前端模块

| 模块 | 职责 |
|------|------|
| `src/lib/quick-reply-templates.ts` | 查询、CRUD、前端变量渲染 |
| `src/components/QuickReplyPicker.tsx` | 工作台选择器 |
| `src/pages/Templates.tsx`（扩展） | 管理 Tab |
| migration | 建表 + RLS + 种子（可选 2–3 条 team 示例） |

**不发新 Edge Function**：模板 CRUD 走 Supabase client + RLS；发送仍走现有 `send-reply`。

### 3.8 验收标准（P1）

- [ ] admin 可 CRUD 团队模板；普通用户可 CRUD 个人模板
- [ ] 工作台可选择模板，支持追加/替换正文
- [ ] 变量按当前邮件上下文正确替换
- [ ] 停用模板不出现在选择器
- [ ] 现有 `reply_templates` 自动回复行为不变
- [ ] Vitest：`renderQuickReplyTemplate()` 单元测试

---

## 4. 功能 B：发件附件与图片

### 4.1 用户故事

- 作为**客服**，我希望在回复中附上 PDF/图片等文件，客户能在邮箱中正常下载。
- （P2b）作为**客服**，我希望在正文中展示图片而非仅作附件。

### 4.2 分阶段范围

| 阶段 | 范围 |
|------|------|
| **P2a** | 文件附件（multipart/mixed） |
| **P2b** | 正文内嵌图片（「插入图片」+ inline CID，非富文本编辑器） |

**不在 MVP**：转发原邮件入站附件、病毒扫描、富文本 WYSIWYG、新建/转发邮件。

### 4.3 P2a 交互

回复区底部工具栏：

```
[📎 添加附件]  已选: invoice.pdf (1.2MB) ✕  screenshot.png ✕
                                              [发送]
```

- 多选文件；列表展示文件名、大小、删除
- 限制（可环境变量配置）：
  - 单文件 ≤ 10MB
  - 总大小 ≤ 25MB
  - 类型白名单：pdf, doc/docx, xls/xlsx, png, jpg, gif, zip 等
- 上传进度条；失败可重试
- 发送成功清空列表；切换邮件时清空未发送附件

### 4.4 P2a 数据流

```
1. 用户选文件 → 前端校验
2. upload → Storage 临时路径
3. send-reply({
     email_id,
     content,
     attachments: [{ storage_path, filename, content_type }],
     subject_override?  // 若快捷回复更新了主题
   })
4. Edge Function：鉴权 → 从 Storage 读取 → build MIME → SMTP
5. email_send_logs.metadata.attachments = [...]
6. 成功或 24h 后清理临时 Storage 对象
```

### 4.5 Storage

- **桶**：新建 `outbound-attachments`（与入站 `email-attachments` 隔离）
- **路径**：`{user_id}/{upload_session_id}/{uuid}_{sanitized_filename}`
- **Policy**：
  - authenticated 用户 upload 到 `{user_id}/*`
  - Edge Function（service role）read + delete

MVP 不新建 DB 表；元数据写入 `email_send_logs.metadata`。若后续需要「草稿暂存附件」再引入 `outbound_attachments` 表。

### 4.6 后端改造

| 文件 | 改动 |
|------|------|
| `supabase/functions/_shared/smtp.ts` | `SendOpts.attachments`；构建 `multipart/mixed`（alternative + attachment parts） |
| `supabase/functions/send-reply/index.ts` | 接收 attachments；Storage 下载；传 smtp；写 metadata |
| migration | Storage bucket + policy |
| cron（可选） | 清理超过 24h 的未引用 outbound 对象 |

**MIME 结构（P2a）**：

```
multipart/mixed
├── multipart/alternative
│   ├── text/plain
│   └── text/html
├── application/pdf (base64)
└── image/png (base64)
```

### 4.7 安全

- 扩展名 + MIME 双重校验
- 文件名消毒（去除 `../`、控制字符）
- 发送前 Edge Function 再次校验大小/类型
- 无附件时行为与现网完全一致（回归重点）

### 4.8 P2b 内嵌图片（可选）

- 「插入图片」按钮：上传 png/jpg → 正文末尾追加占位 + 作为 `Content-Disposition: inline` + `Content-ID` 发送
- 不引入富文本编辑器；HTML 正文由 `plainTextToHtmlEmail` + inline parts 组合
- 若 P2b 延期，P2a 已满足「图片作为附件发送」

### 4.9 验收标准（P2a）

- [ ] 1–5 个合法文件可成功发送，客户邮箱可下载
- [ ] 超大/非法类型被拦截并提示
- [ ] `email_send_logs.metadata` 含附件清单
- [ ] 幂等键防重复发送仍然有效
- [ ] 无附件回复路径回归通过
- [ ] 网易等企业邮 SMTP smoke test

---

## 5. 可观测与日志

`email_send_logs.metadata` 扩展字段：

```json
{
  "quick_reply_template_id": "uuid | null",
  "attachments": [
    { "filename": "a.pdf", "content_type": "application/pdf", "size": 12345 }
  ]
}
```

工作台发送失败时，前端 toast 区分：SMTP 失败 / 附件过大 / Storage 读取失败。

---

## 6. 测试策略

| 层级 | 内容 |
|------|------|
| 单元 | `renderQuickReplyTemplate`、附件校验、文件名消毒 |
| 组件 | `QuickReplyPicker` 插入追加/替换 |
| Edge | `smtp.ts` MIME 构建快照测试；`send-reply` mock Storage |
| 手工 | 真实邮箱收信验证附件与中文文件名 |

---

## 7. 风险与缓解

| 风险 | 缓解 |
|------|------|
| SMTP multipart 兼容性 | 先在测试邮箱验证 163/QQ/Outlook |
| 大附件 Edge Function 超时 | 限制总大小 25MB；超大文件提示用网盘 |
| 临时 Storage 泄漏 | TTL 清理 cron |
| 模板与 AI 草稿冲突 | UI 明确「追加/替换」选择 |

---

## 8. 里程碑

| 里程碑 | 交付 |
|--------|------|
| M1 | migration + RLS + `quick_reply_templates` 类型 |
| M2 | Templates 页快捷回复 Tab + 种子数据 |
| M3 | Workbench `QuickReplyPicker` + 变量渲染 |
| M4 | outbound Storage + `smtp.ts` multipart |
| M5 | Workbench 附件上传 UI + `send-reply` 联调 |
| M6（可选） | P2b 内嵌图片 |

---

## 9. 不在本次范围

- 富文本 WYSIWYG 编辑器
- 新建邮件 / 转发邮件
- 自动转发入站附件到回复
- 附件病毒扫描
- 多语言模板（后续可按 `category` 或新字段扩展）

---

## 10. 规格自检（2026-07-02）

- [x] 无 TBD/占位段落
- [x] 架构与 `reply_templates` 自动回复无矛盾（独立表）
- [x] 作用域决策已锁定：团队 + 个人（选项 B）
- [x] P1/P2 可独立实施与验收
- [x] 附件「文件」与「内嵌图」阶段边界明确
