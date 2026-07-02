# 工作台发件附件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 工作台人工回复支持上传文件附件，经 `send-reply` → SMTP `multipart/mixed` 发送，并在 `email_send_logs.metadata` 记录附件清单。

**Architecture:** 新建私有 Storage 桶 `outbound-attachments`；前端校验并上传至 `{user_id}/{session_id}/{uuid}_{filename}`；`send-reply` 用 service role 下载后传给扩展后的 `sendMail`；无附件时保持现网纯文本路径不变。

**Tech Stack:** React + Supabase Storage + Deno Edge Functions；现有 `_shared/smtp.ts`；Vitest（前端）+ Deno test（MIME）。

**Spec:** [`docs/superpowers/specs/2026-07-02-workbench-attachments-quick-replies-design.md`](../specs/2026-07-02-workbench-attachments-quick-replies-design.md) §4

**Prerequisite:** P1 快捷回复可并行或先发；本计划不依赖 P1，但 Workbench 回复区 UI 会共用同一区块。

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `supabase/migrations/20260702130000_outbound_attachments_bucket.sql` | Create | Storage 桶 + RLS |
| `src/lib/outbound-attachments.ts` | Create | 校验、消毒、上传 helper |
| `src/lib/outbound-attachments.test.ts` | Create | 单元测试 |
| `supabase/functions/_shared/smtp.ts` | Modify | `SendOpts.attachments` + mixed MIME |
| `supabase/functions/_shared/smtp-mime.test.ts` | Modify | mixed 结构测试 |
| `supabase/functions/_shared/outbound-attachment.ts` | Create | Edge 侧校验 + Storage 下载 |
| `supabase/functions/send-reply/index.ts` | Modify | 接收 attachments、写 metadata |
| `src/components/ReplyAttachmentBar.tsx` | Create | 选文件、列表、上传进度 |
| `src/pages/Workbench.tsx` | Modify | 集成附件栏 + sendReply body |

---

### Task 1: Storage bucket migration

**Files:**
- Create: `mail-guide-ai-main/supabase/migrations/20260702130000_outbound_attachments_bucket.sql`

- [ ] **Step 1: 编写 migration**

```sql
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'outbound-attachments',
  'outbound-attachments',
  false,
  10485760, -- 10MB per object (Supabase bucket limit hint)
  ARRAY[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/png',
    'image/jpeg',
    'image/gif',
    'application/zip'
  ]::text[]
)
ON CONFLICT (id) DO NOTHING;

-- 员工仅可上传到自己的目录 {user_id}/...
CREATE POLICY "员工上传出站附件"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'outbound-attachments'
    AND public.is_staff(auth.uid())
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "员工读自己的出站附件"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'outbound-attachments'
    AND public.is_staff(auth.uid())
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "员工删自己的出站附件"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'outbound-attachments'
    AND public.is_staff(auth.uid())
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
```

- [ ] **Step 2: 应用 migration**（同 P1，docker cp + psql）

- [ ] **Step 3: Commit**

```bash
git add mail-guide-ai-main/supabase/migrations/20260702130000_outbound_attachments_bucket.sql
git commit -m "feat(db): add outbound-attachments storage bucket for reply uploads"
```

---

### Task 2: Frontend validation & upload library

**Files:**
- Create: `mail-guide-ai-main/src/lib/outbound-attachments.ts`
- Create: `mail-guide-ai-main/src/lib/outbound-attachments.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, it } from "vitest";
import {
  sanitizeOutboundFilename,
  validateOutboundFile,
  OUTBOUND_MAX_FILE_BYTES,
  OUTBOUND_MAX_TOTAL_BYTES,
} from "./outbound-attachments";

describe("outbound-attachments", () => {
  it("sanitizeOutboundFilename 去除路径字符", () => {
    expect(sanitizeOutboundFilename("../evil.pdf")).toBe("evil.pdf");
    expect(sanitizeOutboundFilename("发票 001.pdf")).toBe("发票 001.pdf");
  });

  it("validateOutboundFile 拒绝超大文件", () => {
    const r = validateOutboundFile(
      { name: "big.pdf", type: "application/pdf", size: OUTBOUND_MAX_FILE_BYTES + 1 },
      0,
    );
    expect(r.ok).toBe(false);
  });

  it("validateOutboundFile 拒绝总大小超限", () => {
    const r = validateOutboundFile(
      { name: "a.pdf", type: "application/pdf", size: 5_000_000 },
      OUTBOUND_MAX_TOTAL_BYTES,
    );
    expect(r.ok).toBe(false);
  });

  it("validateOutboundFile 接受合法 PDF", () => {
    const r = validateOutboundFile(
      { name: "a.pdf", type: "application/pdf", size: 1000 },
      0,
    );
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `cd mail-guide-ai-main && npm test -- src/lib/outbound-attachments.test.ts`

- [ ] **Step 3: Implement**

```typescript
import { supabase } from "@/lib/supabase";

export const OUTBOUND_BUCKET = "outbound-attachments";
export const OUTBOUND_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const OUTBOUND_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
export const OUTBOUND_MAX_FILES = 5;

const ALLOWED_EXT = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "png", "jpg", "jpeg", "gif", "zip",
]);
const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/png",
  "image/jpeg",
  "image/gif",
  "application/zip",
]);

export function sanitizeOutboundFilename(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "attachment";
  return base.replace(/[\x00-\x1f]/g, "").trim() || "attachment";
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function validateOutboundFile(
  file: Pick<File, "name" | "type" | "size">,
  currentTotalBytes: number,
): { ok: true } | { ok: false; reason: string } {
  if (file.size > OUTBOUND_MAX_FILE_BYTES) {
    return { ok: false, reason: `单文件不能超过 ${OUTBOUND_MAX_FILE_BYTES / 1024 / 1024}MB` };
  }
  if (currentTotalBytes + file.size > OUTBOUND_MAX_TOTAL_BYTES) {
    return { ok: false, reason: "附件总大小不能超过 25MB" };
  }
  const ext = extOf(file.name);
  if (!ALLOWED_EXT.has(ext)) {
    return { ok: false, reason: `不支持的文件类型: .${ext || "?"}` };
  }
  if (file.type && !ALLOWED_MIME.has(file.type)) {
    return { ok: false, reason: `不支持的 MIME 类型: ${file.type}` };
  }
  return { ok: true };
}

export type OutboundAttachmentDraft = {
  id: string;
  file: File;
  storagePath?: string;
  uploading: boolean;
  error?: string;
};

export function buildOutboundStoragePath(
  userId: string,
  sessionId: string,
  file: File,
): string {
  const safe = sanitizeOutboundFilename(file.name);
  return `${userId}/${sessionId}/${crypto.randomUUID()}_${safe}`;
}

export async function uploadOutboundAttachment(
  userId: string,
  sessionId: string,
  file: File,
): Promise<{ storagePath: string }> {
  const path = buildOutboundStoragePath(userId, sessionId, file);
  const { error } = await supabase.storage
    .from(OUTBOUND_BUCKET)
    .upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (error) throw error;
  return { storagePath: path };
}
```

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add mail-guide-ai-main/src/lib/outbound-attachments.ts mail-guide-ai-main/src/lib/outbound-attachments.test.ts
git commit -m "feat: add outbound attachment validation and upload helpers"
```

---

### Task 3: SMTP multipart/mixed

**Files:**
- Modify: `mail-guide-ai-main/supabase/functions/_shared/smtp.ts`
- Modify: `mail-guide-ai-main/supabase/functions/_shared/smtp-mime.test.ts`

- [ ] **Step 1: 扩展类型与 builder**

在 `smtp.ts` 增加:

```typescript
export type MailAttachment = {
  filename: string;
  contentType: string;
  content: Uint8Array;
};

interface SendOpts {
  to: string | string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
  attachments?: MailAttachment[];
}

export function buildMultipartMixedBody(
  plain: string,
  html: string,
  attachments: MailAttachment[],
  altBoundary: string,
  mixedBoundary: string,
): string {
  const alternativePart = [
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    "",
    buildMultipartAlternativeBody(plain, html, altBoundary),
  ].join("\r\n");

  const attachmentParts = attachments.map((att) => {
    const b64 = foldBase64(b64(String.fromCharCode(...att.content)));
    const encodedName = encodeSubject(att.filename);
    return [
      `--${mixedBoundary}`,
      `Content-Type: ${att.contentType}; name="${encodedName}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${encodedName}"`,
      "",
      b64,
    ].join("\r\n");
  });

  return [
    alternativePart,
    ...attachmentParts,
    `--${mixedBoundary}--`,
    "",
  ].join("\r\n");
}
```

修改 `sendMail` 内 DATA 构建:

```typescript
const altBoundary = createMultipartBoundary();
const html = plainTextToHtmlEmail(opts.text);
const attachments = opts.attachments ?? [];

if (attachments.length === 0) {
  headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
  const body = buildMultipartAlternativeBody(opts.text, html, altBoundary);
  // ... unchanged
} else {
  const mixedBoundary = createMultipartBoundary();
  headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
  const body = buildMultipartMixedBody(opts.text, html, attachments, altBoundary, mixedBoundary);
  // ...
}
```

- [ ] **Step 2: 增加 Deno 测试**

在 `smtp-mime.test.ts` 追加:

```typescript
import { buildMultipartMixedBody, createMultipartBoundary } from "./smtp.ts";

Deno.test("multipart/mixed nests alternative and attachment", () => {
  const altB = createMultipartBoundary();
  const mixB = createMultipartBoundary();
  const body = buildMultipartMixedBody(
    "hello",
    "<p>hello</p>",
    [{ filename: "a.pdf", contentType: "application/pdf", content: new Uint8Array([1, 2, 3]) }],
    altB,
    mixB,
  );
  assertEquals(body.includes(`multipart/alternative`), true);
  assertEquals(body.includes("Content-Disposition: attachment"), true);
  assertEquals(body.startsWith(`--${mixB}`), true);
});
```

- [ ] **Step 3: Run Deno test**

Run: `cd mail-guide-ai-main/supabase/functions/_shared && deno test smtp-mime.test.ts --allow-env`

Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add mail-guide-ai-main/supabase/functions/_shared/smtp.ts mail-guide-ai-main/supabase/functions/_shared/smtp-mime.test.ts
git commit -m "feat(smtp): support multipart/mixed with file attachments"
```

---

### Task 4: Edge Function attachment loading

**Files:**
- Create: `mail-guide-ai-main/supabase/functions/_shared/outbound-attachment.ts`
- Modify: `mail-guide-ai-main/supabase/functions/send-reply/index.ts`

- [ ] **Step 1: 创建 outbound-attachment.ts**

```typescript
export type OutboundAttachmentInput = {
  storage_path: string;
  filename: string;
  content_type: string;
};

const MAX_FILES = 5;
const MAX_TOTAL = 25 * 1024 * 1024;

export async function loadOutboundAttachments(
  admin: { storage: { from: (b: string) => { download: (p: string) => Promise<{ data: Blob | null; error: unknown }> } } },
  userId: string,
  inputs: OutboundAttachmentInput[],
): Promise<{ filename: string; contentType: string; content: Uint8Array }[]> {
  if (!inputs?.length) return [];
  if (inputs.length > MAX_FILES) throw new Error(`附件数量不能超过 ${MAX_FILES} 个`);

  const out: { filename: string; contentType: string; content: Uint8Array }[] = [];
  let total = 0;

  for (const item of inputs) {
    const prefix = `${userId}/`;
    if (!item.storage_path.startsWith(prefix)) {
      throw new Error("无权使用该附件");
    }
    const { data, error } = await admin.storage.from("outbound-attachments").download(item.storage_path);
    if (error || !data) throw new Error(`读取附件失败: ${item.filename}`);
    const buf = new Uint8Array(await data.arrayBuffer());
    total += buf.byteLength;
    if (total > MAX_TOTAL) throw new Error("附件总大小超过限制");
    out.push({
      filename: item.filename,
      contentType: item.content_type || "application/octet-stream",
      content: buf,
    });
  }
  return out;
}
```

- [ ] **Step 2: 修改 send-reply/index.ts**

解析 body 增加:

```typescript
const { email_id, content, subject_override, idempotency_key, attachments: attachmentInputs } = await req.json();
```

在 `sendMail` 前:

```typescript
const mailAttachments = await loadOutboundAttachments(admin, userData.user.id, attachmentInputs ?? []);
```

调用:

```typescript
messageId = await sendMail(mb, {
  to: replyToEmail,
  subject: replySubject,
  text: bodyWithSignature,
  inReplyTo: email.message_id ?? undefined,
  references: email.message_id ?? undefined,
  attachments: mailAttachments,
});
```

`sendLogPayload.metadata` 合并:

```typescript
metadata: {
  ...operatorMetadata,
  attachments: (attachmentInputs ?? []).map((a: { filename: string; content_type: string; storage_path: string }) => ({
    filename: a.filename,
    content_type: a.content_type,
    storage_path: a.storage_path,
  })),
},
```

发送成功后异步删除 Storage（best-effort）:

```typescript
if (!sendError && attachmentInputs?.length) {
  for (const a of attachmentInputs) {
    await admin.storage.from("outbound-attachments").remove([a.storage_path]);
  }
}
```

- [ ] **Step 3: 同步 Edge Function 到自建栈**（见 `mail-guide-ai-main/docs/self-hosted-supabase.md`）

- [ ] **Step 4: Commit**

```bash
git add mail-guide-ai-main/supabase/functions/_shared/outbound-attachment.ts mail-guide-ai-main/supabase/functions/send-reply/index.ts
git commit -m "feat(send-reply): send manual replies with outbound file attachments"
```

---

### Task 5: Workbench attachment UI

**Files:**
- Create: `mail-guide-ai-main/src/components/ReplyAttachmentBar.tsx`
- Modify: `mail-guide-ai-main/src/pages/Workbench.tsx`

- [ ] **Step 1: ReplyAttachmentBar 组件**

Props:

```typescript
type ReplyAttachmentBarProps = {
  disabled?: boolean;
  userId: string;
  sessionId: string;
  items: OutboundAttachmentDraft[];
  onChange: (items: OutboundAttachmentDraft[]) => void;
};
```

行为:
- hidden `<input type="file" multiple />` + 「添加附件」按钮
- 选文件 → `validateOutboundFile` → 自动 `uploadOutboundAttachment` → 更新 `storagePath`
- 展示文件名、大小、删除、uploading/error 状态
- 最多 `OUTBOUND_MAX_FILES` 个

- [ ] **Step 2: Workbench 集成**

State:

```typescript
const [replyAttachmentSessionId] = useState(() => crypto.randomUUID());
const [replyAttachments, setReplyAttachments] = useState<OutboundAttachmentDraft[]>([]);
```

切换 `selectedId` 时 `setReplyAttachments([])`。

在回复 `Textarea` 下方、`发送` 按钮上方插入 `ReplyAttachmentBar`。

修改 `sendReply`:

```typescript
const pending = replyAttachments.filter((a) => !a.storagePath || a.uploading);
if (pending.length > 0) {
  toast.error("请等待附件上传完成");
  return;
}
const { data, error } = await supabase.functions.invoke("send-reply", {
  body: {
    email_id: selectedId,
    content: replyContent,
    ...(replySubjectOverride ? { subject_override: replySubjectOverride } : {}),
    attachments: replyAttachments.map((a) => ({
      storage_path: a.storagePath!,
      filename: sanitizeOutboundFilename(a.file.name),
      content_type: a.file.type || "application/octet-stream",
    })),
  },
});
// 成功后 setReplyAttachments([])
```

- [ ] **Step 3: 手工验证**

- 上传 1 个 PDF + 1 个 PNG → 发送 → 客户邮箱可下载
- 超 10MB 单文件 → 前端拦截
- 无附件发送 → 与现网一致
- `email_send_logs.metadata.attachments` 有记录

- [ ] **Step 4: Commit**

```bash
git add mail-guide-ai-main/src/components/ReplyAttachmentBar.tsx mail-guide-ai-main/src/pages/Workbench.tsx
git commit -m "feat: workbench reply attachment upload and send"
```

---

## P2a 验收清单

- [ ] 1–5 个合法附件成功发送且收件方可下载
- [ ] 超大/非法类型前后端拦截
- [ ] 无附件路径回归通过
- [ ] `npm test` + `deno test smtp-mime.test.ts` 通过
- [ ] 真实 SMTP smoke test（163/企业邮）

---

## P2b 内嵌图片（可选，单独 Task）

不在 P2a 范围。若要做：
- `ReplyAttachmentBar` 增加「插入图片」模式
- `MailAttachment` 增加 `contentId` + `Content-Disposition: inline`
- HTML 正文追加 `<img src="cid:...">`

---

## Spec Coverage Self-Review

| Spec §4 要求 | Task |
|--------------|------|
| outbound Storage 桶 | Task 1 |
| 前端校验/上传 | Task 2, 5 |
| smtp multipart/mixed | Task 3 |
| send-reply 扩展 | Task 4 |
| metadata.attachments | Task 4 |
| 切换邮件清空 | Task 5 |
| 10MB/25MB 限制 | Task 2, 4 |

无 TBD；P2a 可独立于 P2b 发版。
