# 工作台快捷回复模板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在工作台提供团队 + 个人快捷回复模板，支持变量替换、追加/替换正文，并在 `/templates` 页管理。

**Architecture:** 新建 `quick_reply_templates` 表（与 `reply_templates` 自动回邮分离）；前端 `quick-reply-templates.ts` 负责 CRUD 与 `renderQuickReplyTemplate`；`QuickReplyPicker` 嵌入 Workbench 回复区；`/templates` 改为全员可进、Tab 内按 admin 区分自动回邮 vs 快捷回复管理。

**Tech Stack:** React 18 + TypeScript + Supabase JS + Vitest；Postgres RLS；shadcn/ui Tabs/Popover/Dialog。

**Spec:** [`docs/superpowers/specs/2026-07-02-workbench-attachments-quick-replies-design.md`](../specs/2026-07-02-workbench-attachments-quick-replies-design.md) §3

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `supabase/migrations/20260702120000_quick_reply_templates.sql` | Create | 表、索引、RLS、种子 |
| `src/lib/quick-reply-templates.ts` | Create | 类型、查询、渲染、分组 |
| `src/lib/quick-reply-templates.test.ts` | Create | 变量渲染单元测试 |
| `src/components/QuickReplyPicker.tsx` | Create | 工作台选择器 + 插入确认 |
| `src/components/QuickReplyTemplatesTab.tsx` | Create | 管理页 CRUD（团队/个人） |
| `src/pages/Templates.tsx` | Modify | 增加 Tabs；自动回邮 Tab 仅 admin |
| `src/pages/Workbench.tsx` | Modify | 集成 Picker；可选 subject state |
| `src/App.tsx` | Modify | `/templates` 路由改为非 adminOnly |
| `src/components/AppLayout.tsx` | Modify | 导航文案改为「模板管理」，全员可见 |
| `src/integrations/supabase/types.ts` | Regenerate | 含新表类型（手动或 `supabase gen types`） |

---

### Task 1: Database migration

**Files:**
- Create: `mail-guide-ai-main/supabase/migrations/20260702120000_quick_reply_templates.sql`

- [ ] **Step 1: 编写 migration**

```sql
-- 快捷回复模板（人工插入；与 reply_templates 自动回邮分离）
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

ALTER TABLE public.quick_reply_templates ENABLE ROW LEVEL SECURITY;

-- 员工可读团队模板 + 本人的个人模板
CREATE POLICY "员工可读快捷回复"
  ON public.quick_reply_templates FOR SELECT TO authenticated
  USING (
    public.is_staff(auth.uid()) AND (
      scope = 'team' OR owner_id = auth.uid()
    )
  );

CREATE POLICY "管理员管理团队快捷回复"
  ON public.quick_reply_templates FOR INSERT TO authenticated
  WITH CHECK (
    scope = 'team' AND public.has_role(auth.uid(), 'admin')
  );

CREATE POLICY "管理员更新团队快捷回复"
  ON public.quick_reply_templates FOR UPDATE TO authenticated
  USING (scope = 'team' AND public.has_role(auth.uid(), 'admin'))
  WITH CHECK (scope = 'team' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "管理员删除团队快捷回复"
  ON public.quick_reply_templates FOR DELETE TO authenticated
  USING (scope = 'team' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "用户管理个人快捷回复"
  ON public.quick_reply_templates FOR ALL TO authenticated
  USING (scope = 'personal' AND owner_id = auth.uid())
  WITH CHECK (scope = 'personal' AND owner_id = auth.uid());

-- 种子：团队示例（仅当表为空时）
INSERT INTO public.quick_reply_templates (title, body_template, subject_template, category, business_intents, scope, sort_order)
SELECT * FROM (VALUES
  (
    '请提供订单号',
    E'您好 {{from_name}}，\n\n感谢来信。为尽快处理，请提供您的订单号。\n\n谢谢！',
    NULL::text,
    '缺信息',
    ARRAY['missing_order']::text[],
    'team',
    10
  ),
  (
    '已安排发货说明',
    E'您好 {{from_name}}，\n\n您的订单 {{order_no}} 已安排发货，请留意物流更新。\n\n如有疑问欢迎随时联系我们。',
    NULL::text,
    '物流',
    ARRAY['shipping_inquiry']::text[],
    'team',
    20
  )
) AS v(title, body_template, subject_template, category, business_intents, scope, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.quick_reply_templates WHERE scope = 'team' LIMIT 1);
```

- [ ] **Step 2: 本地应用 migration**

Run（在 `supabase-selfhost` 栈已启动时，见 `DEPLOY.md` §六）:

```bash
cd d:/Docker/project/cs-main/supabase-selfhost
docker compose cp ../mail-guide-ai-main/supabase/migrations/20260702120000_quick_reply_templates.sql db:/tmp/quick_reply.sql
docker compose exec db psql -U postgres -d postgres -f /tmp/quick_reply.sql
```

Expected: `CREATE TABLE` / `CREATE POLICY` 无 ERROR。

- [ ] **Step 3: Commit**

```bash
git add mail-guide-ai-main/supabase/migrations/20260702120000_quick_reply_templates.sql
git commit -m "feat(db): add quick_reply_templates for workbench canned responses"
```

---

### Task 2: Template render library + tests

**Files:**
- Create: `mail-guide-ai-main/src/lib/quick-reply-templates.ts`
- Create: `mail-guide-ai-main/src/lib/quick-reply-templates.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/quick-reply-templates.test.ts
import { describe, expect, it } from "vitest";
import {
  renderQuickReplyTemplate,
  type QuickReplyTemplateContext,
} from "./quick-reply-templates";

const ctx: QuickReplyTemplateContext = {
  from_name: "Alice",
  from_email: "alice@example.com",
  subject: "Where is my order?",
  reply_to_email: "alice@example.com",
  order_no: "SO-001",
  missing_elements: "order_no",
};

describe("renderQuickReplyTemplate", () => {
  it("替换已知占位符", () => {
    const out = renderQuickReplyTemplate(
      "Hi {{from_name}}, order {{order_no}}",
      ctx,
    );
    expect(out).toBe("Hi Alice, order SO-001");
  });

  it("未知键替换为空串", () => {
    const out = renderQuickReplyTemplate("{{unknown_key}}", ctx);
    expect(out).toBe("");
  });

  it("from_name 为空时回退 from_email", () => {
    const out = renderQuickReplyTemplate(
      "{{from_name}}",
      { ...ctx, from_name: "" },
    );
    expect(out).toBe("alice@example.com");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mail-guide-ai-main && npm test -- src/lib/quick-reply-templates.test.ts`

Expected: FAIL — module `./quick-reply-templates` not found

- [ ] **Step 3: Implement library**

```typescript
// src/lib/quick-reply-templates.ts
import { supabase } from "@/lib/supabase";

export type QuickReplyScope = "team" | "personal";

export type QuickReplyTemplateRow = {
  id: string;
  title: string;
  body_template: string;
  subject_template: string | null;
  category: string | null;
  business_intents: string[];
  scope: QuickReplyScope;
  owner_id: string | null;
  sort_order: number;
  is_active: boolean;
};

export type QuickReplyTemplateContext = {
  from_name: string;
  from_email: string;
  subject: string;
  reply_to_email: string;
  order_no: string;
  missing_elements: string;
};

export function renderQuickReplyTemplate(
  template: string,
  ctx: QuickReplyTemplateContext,
): string {
  const fromName = ctx.from_name.trim() || ctx.from_email;
  const values: Record<string, string> = {
    from_name: fromName,
    from_email: ctx.from_email,
    subject: ctx.subject,
    reply_to_email: ctx.reply_to_email,
    order_no: ctx.order_no,
    missing_elements: ctx.missing_elements,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => values[key] ?? "");
}

export function buildQuickReplyContextFromEmail(
  email: {
    from_name?: string | null;
    from_email?: string | null;
    subject?: string | null;
    missing_elements?: string[] | null;
  },
  orderNo = "",
  replyToEmail = "",
): QuickReplyTemplateContext {
  const fromEmail = email.from_email ?? "";
  return {
    from_name: (email.from_name ?? "").trim(),
    from_email: fromEmail,
    subject: email.subject?.trim() || fromEmail,
    reply_to_email: replyToEmail || fromEmail,
    order_no: orderNo,
    missing_elements: (email.missing_elements ?? []).join(", "),
  };
}

export async function fetchActiveQuickReplyTemplates(userId: string) {
  const { data, error } = await supabase
    .from("quick_reply_templates")
    .select("*")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return (data ?? []) as QuickReplyTemplateRow[];
}

export type QuickReplyGroup = {
  key: string;
  label: string;
  templates: QuickReplyTemplateRow[];
};

export function groupQuickReplyTemplates(
  rows: QuickReplyTemplateRow[],
  businessIntent?: string | null,
): QuickReplyGroup[] {
  const team = rows.filter((r) => r.scope === "team");
  const personal = rows.filter((r) => r.scope === "personal");

  const byCategory = new Map<string, QuickReplyTemplateRow[]>();
  for (const t of team) {
    const cat = t.category?.trim() || "团队模板";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(t);
  }

  const sortMatchedFirst = (list: QuickReplyTemplateRow[]) => {
    if (!businessIntent) return list;
    return [...list].sort((a, b) => {
      const aMatch = a.business_intents.includes(businessIntent) ? 0 : 1;
      const bMatch = b.business_intents.includes(businessIntent) ? 0 : 1;
      return aMatch - bMatch || a.sort_order - b.sort_order;
    });
  };

  const groups: QuickReplyGroup[] = [];
  for (const [label, templates] of byCategory) {
    groups.push({ key: `team-${label}`, label, templates: sortMatchedFirst(templates) });
  }
  if (personal.length > 0) {
    groups.push({
      key: "personal",
      label: "我的模板",
      templates: sortMatchedFirst(personal),
    });
  }
  return groups;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mail-guide-ai-main && npm test -- src/lib/quick-reply-templates.test.ts`

Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add mail-guide-ai-main/src/lib/quick-reply-templates.ts mail-guide-ai-main/src/lib/quick-reply-templates.test.ts
git commit -m "feat: add quick reply template render and grouping helpers"
```

---

### Task 3: Route & navigation access for all staff

**Files:**
- Modify: `mail-guide-ai-main/src/App.tsx`
- Modify: `mail-guide-ai-main/src/components/AppLayout.tsx`

- [ ] **Step 1: 放开 `/templates` 路由（员工均可访问）**

在 `App.tsx` 将:

```tsx
<Route path="/templates" element={<ProtectedRoute adminOnly><Templates /></ProtectedRoute>} />
```

改为:

```tsx
<Route path="/templates" element={<ProtectedRoute><Templates /></ProtectedRoute>} />
```

- [ ] **Step 2: 导航移到「日常作业」并改名**

在 `AppLayout.tsx`:
- 从 `系统配置` 组删除 `{ to: "/templates", ... adminOnly: true }`
- 在 `日常作业` 组增加:

```tsx
{ to: "/templates", label: "模板管理", icon: MessageSquare },
```

- [ ] **Step 3: 手工验证**

启动 `npm run dev`，以非 admin 员工登录，确认侧栏可见「模板管理」且可打开 `/templates`。

- [ ] **Step 4: Commit**

```bash
git add mail-guide-ai-main/src/App.tsx mail-guide-ai-main/src/components/AppLayout.tsx
git commit -m "feat: allow all staff to access templates page for quick replies"
```

---

### Task 4: Templates page — Quick Reply management tab

**Files:**
- Create: `mail-guide-ai-main/src/components/QuickReplyTemplatesTab.tsx`
- Modify: `mail-guide-ai-main/src/pages/Templates.tsx`

- [ ] **Step 1: 创建 QuickReplyTemplatesTab**

实现要点（单文件组件，约 200 行）:
- props: `{ isAdmin: boolean; userId: string }`
- `load()`：`supabase.from("quick_reply_templates").select("*").order("sort_order")`
- **团队区**（`isAdmin` 时显示）：Table + Dialog 新建/编辑 team 模板（title, body, subject, category, business_intents 多选, sort_order, is_active）
- **个人区**（所有用户）：同上但 `scope: 'personal'`, insert 时 `owner_id: userId`
- 预览按钮：调用 `renderQuickReplyTemplate` + 与 `Templates.tsx` 相同的 `REPLY_TEMPLATE_PLACEHOLDER_REF` 样例上下文
- 删除：`.delete().eq("id", id)`

- [ ] **Step 2: Templates.tsx 增加 Tabs**

页面顶部改为:

```tsx
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import QuickReplyTemplatesTab from "@/components/QuickReplyTemplatesTab";
import { useAuth } from "@/hooks/useAuth";

// 在 TemplatesPage 内:
const { isAdmin, user } = useAuth();
const defaultTab = location.hash === "#quick-replies" ? "quick-replies" : "auto-reply";

<Tabs defaultValue={defaultTab}>
  <TabsList>
    {isAdmin && <TabsTrigger value="auto-reply">自动回邮</TabsTrigger>}
    <TabsTrigger value="quick-replies">快捷回复</TabsTrigger>
  </TabsList>
  {isAdmin && (
    <TabsContent value="auto-reply">{/* 现有 SlotEditor 内容 */}</TabsContent>
  )}
  <TabsContent value="quick-replies">
    <QuickReplyTemplatesTab isAdmin={isAdmin} userId={user!.id} />
  </TabsContent>
</Tabs>
```

非 admin 用户默认 Tab 为 `quick-replies`（`defaultValue={isAdmin ? defaultTab : "quick-replies"}`）。

- [ ] **Step 3: 手工验证**

- admin：两个 Tab 均可见，可 CRUD 团队 + 个人模板
- 普通员工：仅「快捷回复」Tab，可 CRUD 个人模板，团队模板只读

- [ ] **Step 4: Commit**

```bash
git add mail-guide-ai-main/src/components/QuickReplyTemplatesTab.tsx mail-guide-ai-main/src/pages/Templates.tsx
git commit -m "feat: add quick reply templates management tab"
```

---

### Task 5: Workbench QuickReplyPicker

**Files:**
- Create: `mail-guide-ai-main/src/components/QuickReplyPicker.tsx`
- Modify: `mail-guide-ai-main/src/pages/Workbench.tsx`

- [ ] **Step 1: 创建 QuickReplyPicker**

Props:

```typescript
type QuickReplyPickerProps = {
  disabled?: boolean;
  context: QuickReplyTemplateContext;
  businessIntent?: string | null;
  onInsert: (payload: {
    body: string;
    subject?: string;
    templateId: string;
    mode: "append" | "replace";
  }) => void;
};
```

UI:
- `Popover` + `Button`「快捷回复」
- mount 时 `fetchActiveQuickReplyTemplates` + `groupQuickReplyTemplates`
- 点击条目 → `Dialog` 三选项：追加 / 替换 / 取消；若 `subject_template` 非空，Checkbox「同时更新主题」
- 渲染：`renderQuickReplyTemplate(body_template, context)`；subject 同理

- [ ] **Step 2: 集成 Workbench**

在 `Workbench.tsx` 回复区（约 2854 行）:

1. 新增 state:

```typescript
const [replySubjectOverride, setReplySubjectOverride] = useState<string | null>(null);
const [lastQuickReplyTemplateId, setLastQuickReplyTemplateId] = useState<string | null>(null);
```

2. `loadDetail` / 切换邮件时重置上述 state

3. 在 `<h3>回复内容</h3>` 与 `Textarea` 之间插入:

```tsx
<div className="flex flex-wrap items-center gap-2 mb-2">
  <QuickReplyPicker
    disabled={!canOperate || !selected}
    context={buildQuickReplyContextFromEmail(selected ?? {}, linkedOrderNo, selected?.from_email ?? "")}
    businessIntent={selected?.business_intent}
    onInsert={({ body, subject, templateId, mode }) => {
      setReplyContent((prev) => (mode === "replace" ? body : prev ? `${prev}\n\n${body}` : body));
      if (subject) setReplySubjectOverride(subject);
      setLastQuickReplyTemplateId(templateId);
    }}
  />
</div>
```

4. 修改 `sendReply`:

```typescript
body: {
  email_id: selectedId,
  content: replyContent,
  ...(replySubjectOverride ? { subject_override: replySubjectOverride } : {}),
},
```

5. `send-reply` 成功后在 `operatorMetadata` 或前端暂不写 template_id（P2 日志扩展在附件计划）；本阶段可在 `email_processing_events` 插入 `quick_reply_used` 事件（可选，YAGNI 可跳过）。

- [ ] **Step 3: 手工验证**

- 选模板 → 追加/替换正文正确
- 含 subject 模板 + 勾选更新主题 → 发出邮件主题正确（查 `email_send_logs.subject`）
- 停用模板不在 Picker 出现

- [ ] **Step 4: Commit**

```bash
git add mail-guide-ai-main/src/components/QuickReplyPicker.tsx mail-guide-ai-main/src/pages/Workbench.tsx
git commit -m "feat: integrate quick reply picker in workbench"
```

---

### Task 6: Regenerate Supabase types

**Files:**
- Modify: `mail-guide-ai-main/src/integrations/supabase/types.ts`

- [ ] **Step 1: 更新 types**

若本地有 linked project，运行:

```bash
cd mail-guide-ai-main && npx supabase gen types typescript --local > src/integrations/supabase/types.ts
```

否则手动在 `Database.public.Tables` 增加 `quick_reply_templates` 行类型（与 migration 字段一致）。

- [ ] **Step 2: Commit**

```bash
git add mail-guide-ai-main/src/integrations/supabase/types.ts
git commit -m "chore: regenerate supabase types for quick_reply_templates"
```

---

## P1 验收清单

- [ ] admin CRUD 团队模板；员工 CRUD 个人模板
- [ ] 工作台快捷回复：追加/替换 + 变量替换
- [ ] 停用模板不可选
- [ ] `npm test` 通过（含 `quick-reply-templates.test.ts`）
- [ ] 现有 `reply_templates` / `process-email` 自动回邮无回归

---

## Spec Coverage Self-Review

| Spec §3 要求 | Task |
|--------------|------|
| 独立表 + RLS | Task 1 |
| 变量占位符 | Task 2 |
| 团队 + 个人 scope | Task 1, 4 |
| 工作台 Picker | Task 5 |
| /templates Tab | Task 3, 4 |
| Vitest render | Task 2 |
| subject_override | Task 5 |

无占位段落；P1 可独立发版。
