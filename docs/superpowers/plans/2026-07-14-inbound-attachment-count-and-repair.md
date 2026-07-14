# 入站附件数量对齐 + 补拉门闸修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让工作台「待补拉」附件数量与 Gmail 用户附件对齐，并保证几 MB 内小邮件走 IMAP 分段补拉而非因虚高 count 空转排队。

**Architecture:** 在 `imap-bodystructure` 区分 user vs inline part；`detectAttachments.count` 改用用户附件数；去掉 `count>=3` 大门闸；`repairEmailByIdFull` 与附件补拉 worker 透传明确错误。前端展示沿用后端校准后的 `count`，无需大改 UI。

**Tech Stack:** Deno Edge Functions、现有 IMAP BODYSTRUCTURE 解析、Vitest（前端纯函数若抽出）、Supabase Storage 路径不变。

**Spec:** `docs/superpowers/specs/2026-07-14-inbound-attachment-count-and-repair-design.md`

---

## File map

| 文件 | 职责 |
|------|------|
| `mail-guide-ai-main/supabase/functions/_shared/imap-bodystructure.ts` | part 分类（user/inline）、`countUserAttachments` |
| `mail-guide-ai-main/supabase/functions/_shared/imap-bodystructure.test.ts` | BODYSTRUCTURE 单测 |
| `mail-guide-ai-main/supabase/functions/sync-mailbox/index.ts` | detectAttachments、门闸、交互/全量补拉回传、inline 默认 3MB |
| `mail-guide-ai-main/supabase/functions/run-email-attachment-repair-tasks/index.ts` | last_error 透传 queue_reason/error |

---

### Task 1: BODYSTRUCTURE 用户附件 vs 内嵌分类

**Files:**
- Modify: `mail-guide-ai-main/supabase/functions/_shared/imap-bodystructure.ts`
- Modify: `mail-guide-ai-main/supabase/functions/_shared/imap-bodystructure.test.ts`

- [x] **Step 1: 写失败单测（Gmail 风格 mixed + related）**

在 `imap-bodystructure.test.ts` 追加：

```typescript
Deno.test("countUserAttachments ignores inline images, counts attachment disposition", () => {
  // multipart/MIXED(
  //   multipart/RELATED( text/html, image/png inline logo ),
  //   image/jpeg attachment,
  //   image/jpeg attachment
  // )
  const raw = [
    `* 1 FETCH (BODYSTRUCTURE (`,
    ` (("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 500 10 NIL NIL NIL NIL)`,
    `  ("IMAGE" "PNG" ("NAME" "logo.png") "<logo@cid>" NIL "BASE64" 2000 NIL ("INLINE" ("FILENAME" "logo.png")) NIL NIL)`,
    `  "RELATED" ("BOUNDARY" "rel") NIL NIL)`,
    ` ("IMAGE" "JPEG" ("NAME" "IMG_6406.jpeg") NIL NIL "BASE64" 1300000 NIL ("ATTACHMENT" ("FILENAME" "IMG_6406.jpeg")) NIL NIL)`,
    ` ("IMAGE" "JPEG" ("NAME" "IMG_6407.jpeg") NIL NIL "BASE64" 1400000 NIL ("ATTACHMENT" ("FILENAME" "IMG_6407.jpeg")) NIL NIL)`,
    ` "MIXED" ("BOUNDARY" "mix") NIL NIL) RFC822.SIZE 2800000)`,
  ].join("");

  const userCount = countUserAttachments(raw);
  assertEquals(userCount, 2);

  const parts = parseAttachmentPartSections(raw);
  const userParts = parts.filter((p) => p.kind === "user");
  const inlineParts = parts.filter((p) => p.kind === "inline");
  assertEquals(userParts.length, 2);
  assertEquals(inlineParts.length >= 1, true);
});

Deno.test("filename without disposition still counts as user attachment", () => {
  const raw = [
    `* 1 FETCH (BODYSTRUCTURE (`,
    `("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 20 1)`,
    `("APPLICATION" "PDF" ("NAME" "a.pdf") NIL NIL "BASE64" 4096)`,
    ` "MIXED" ("BOUNDARY" "b") NIL NIL) RFC822.SIZE 5000)`,
  ].join("");
  assertEquals(countUserAttachments(raw), 1);
});
```

- [x] **Step 2: 运行测试确认失败**

```bash
cd mail-guide-ai-main/supabase/functions
deno test _shared/imap-bodystructure.test.ts
```

Expected: FAIL（`countUserAttachments` / `kind` 未定义）

- [x] **Step 3: 实现分类与 count**

更新 `imap-bodystructure.ts`：

```typescript
export type AttachmentPartKind = "user" | "inline";

export type AttachmentPartSection = {
  section: string;
  filename: string | null;
  contentType: string;
  sizeBytes: number;
  contentId: string | null;
  kind: AttachmentPartKind;
};

// 在 parseLeafPart 末尾分类逻辑替换原 isAttachment：
// - disposition === "attachment" → kind "user"
// - disposition === "inline" && image → kind "inline"（仍返回 section，供补拉）
// - 无 disposition、非 text、有 filename → kind "user"
// - 无 disposition、无 filename、image → kind "inline"
// - 其他非 text 二进制叶子 → kind "user"
// - text / multipart / message → null（不返回）

export function countUserAttachments(metaRaw: string): number {
  return parseAttachmentPartSections(metaRaw).filter((p) => p.kind === "user").length;
}

// parseAttachmentPartSections：保持拉 user + inline（补拉仍可拿内嵌图）
// 调用方可按 kind 过滤；count 只用 user
```

`parseLeafPart` 核心分类（示意）：

```typescript
  const contentType = `${type}/${subtype || "octet-stream"}`;
  const isImage = type === "image";
  let kind: AttachmentPartKind | null = null;
  if (type === "multipart" || type === "message" || type === "text") {
    // text：仅当 disposition=attachment 才当 user
    if (type === "text" && dispType === "attachment") kind = "user";
    else return null;
  } else if (dispType === "attachment") {
    kind = "user";
  } else if (dispType === "inline" && isImage) {
    kind = "inline";
  } else if (filename) {
    kind = "user";
  } else if (isImage) {
    kind = "inline";
  } else {
    kind = "user";
  }

  return { section, filename, contentType, sizeBytes: sizeBytes || 0, contentId, kind };
```

- [x] **Step 4: 再跑测试至 PASS**

```bash
deno test _shared/imap-bodystructure.test.ts
```

Expected: PASS（含原有 PDF 用例；若缺 `kind` 字段则同步修旧测试断言）

- [x] **Step 5: Commit（仅当用户要求时执行）**

```bash
git add mail-guide-ai-main/supabase/functions/_shared/imap-bodystructure.ts \
  mail-guide-ai-main/supabase/functions/_shared/imap-bodystructure.test.ts
git commit -m "$(cat <<'EOF'
fix(mail): classify IMAP BODYSTRUCTURE user vs inline parts

EOF
)"
```

---

### Task 2: `detectAttachments` 校准 + 去掉 count≥3 门闸

**Files:**
- Modify: `mail-guide-ai-main/supabase/functions/sync-mailbox/index.ts`

- [x] **Step 1: 更新 import**

```typescript
import {
  parseAttachmentPartSections,
  countUserAttachments,
} from "../_shared/imap-bodystructure.ts";
```

- [x] **Step 2: 重写 `detectAttachments`**

保留启发式 `hasAttachment`；`count` 改用 `countUserAttachments`：

```typescript
function detectAttachments(metaRaw: string): { hasAttachment: boolean; count: number } {
  const raw = metaRaw;
  let hasAttachment = false;

  if (/"attachment"/i.test(raw)) hasAttachment = true;
  if (/BODYSTRUCTURE/i.test(raw) && /\bMIXED\b/i.test(raw)) hasAttachment = true;
  if (/FILENAME\s*=/i.test(raw) || /\bNAME\s*=\s*"/i.test(raw)) hasAttachment = true;

  const userCount = countUserAttachments(raw);
  if (userCount > 0) hasAttachment = true;

  const count = userCount > 0
    ? userCount
    : (hasAttachment ? 1 : 0);

  return { hasAttachment, count };
}
```

- [x] **Step 3: 删除 / 降级 `placeholderSuggestsLargeMail`**

按 spec：禁止用 count 推断「大」。改为**恒 false**或删除所有调用点。

推荐：函数改为直接 `return false`，并删除交互路径上的短路块；`repairAttachmentsForRecord` 的 `deferLarge` 只保留体积：

```typescript
function placeholderSuggestsLargeMail(_attachments: unknown): boolean {
  // 2026-07-14：大邮件只看 RFC822.SIZE，不再用占位 count / 历史 note 挡补拉
  return false;
}
```

并删掉 `repairEmailById` 中：

```typescript
if (placeholderSuggestsLargeMail(row.attachments)) {
  // enqueue-only 短路 —— 整段删除
}
```

`repairAttachmentsForRecord`：

```typescript
const deferLarge = rfc822Size > rfc822Limit;
// 删除 (!opts.skipPlaceholderGate && placeholderSuggestsLargeMail(...))
```

- [x] **Step 4: 默认 auto inline 上限 1.5MB → 3MB**

```typescript
const DEFAULT_INCREMENTAL_INLINE_MAX_BYTES_AUTO = 3_000_000;
```

- [x] **Step 5: Commit（仅当用户要求时）**

```bash
git add mail-guide-ai-main/supabase/functions/sync-mailbox/index.ts
git commit -m "$(cat <<'EOF'
fix(mail): align attachment count and remove count-based large-mail gate

EOF
)"
```

---

### Task 3: `repairEmailByIdFull` 明确回传 + worker 透传

**Files:**
- Modify: `mail-guide-ai-main/supabase/functions/sync-mailbox/index.ts`（`repairEmailByIdFull`）
- Modify: `mail-guide-ai-main/supabase/functions/run-email-attachment-repair-tasks/index.ts`

- [x] **Step 1: 修 `repairEmailByIdFull` 正文已有分支**

将「附件补拉失败仍返回 `skipped: true`」改为按 `attStatus` 回传：

```typescript
  if (!isBodyEmpty(row.body_text, row.body_html)) {
    if (needsAtt && row.has_attachment) {
      let client: ImapClient | null = null;
      try {
        client = await connectImapClient(mb, { connectTimeoutMs: 4_000, attempts: 1 });
        const attStatus = await repairAttachmentsForRecord(
          client,
          admin,
          mb,
          row as EmailAttachmentRepairRow,
          maxBytesNoAttach,
          maxBytesWithAttach,
          { skipPlaceholderGate: true },
        );
        if (attStatus === "repaired") {
          return {
            ...emptyResult(mb.email_address, { repaired: 1, fetched: 1, total: 1 }),
            post_processed: false,
          };
        }
        if (attStatus === "queued_large") {
          return {
            ...emptyResult(mb.email_address, {
              repaired: 0,
              queued: true,
              queue_reason: "rfc822_size_exceeds_batch_limit",
            }),
            post_processed: false,
          };
        }
        const errMsg =
          attStatus === "skip_no_uid"
            ? "无法在邮箱中定位该邮件"
            : "IMAP 附件补拉未解析出二进制";
        return {
          ...emptyResult(mb.email_address, { repaired: 0, error: errMsg }),
          post_processed: false,
        };
      } catch (attErr) {
        const msg = attErr instanceof Error ? attErr.message : String(attErr);
        console.error("[repair full] attachment-only", emailId, attErr);
        return {
          ...emptyResult(mb.email_address, { repaired: 0, error: msg.slice(0, 500) }),
          post_processed: false,
        };
      } finally {
        if (client) await client.logout();
      }
    }
    const post = await finalizePostBodyRepair(admin, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, emailId);
    return {
      ...emptyResult(mb.email_address, { skipped: true, repaired: 0 }),
      post_processed: post.ok,
    };
  }
```

注意：仅当**不需要**附件补拉时，才走最后的 `skipped: true`。

- [x] **Step 2: worker 读取 `error` / `queue_reason`**

在 `run-email-attachment-repair-tasks/index.ts` 的 `repaired <= 0` 分支：

```typescript
        const repaired = Number(row?.repaired ?? 0);
        if (repaired > 0) {
          // ... resolved 不变
        } else {
          const maxAttempts = locked.max_attempts ?? 6;
          const attempts = locked.attempt_count ?? 1;
          const detail =
            (typeof row?.error === "string" && row.error) ||
            (typeof row?.queue_reason === "string" && row.queue_reason) ||
            "附件补拉未完成";
          const classification = classifyAttachmentRepairFailure(
            String(detail).slice(0, 500),
            attempts,
            maxAttempts,
          );
          // 后续 pending/failed 更新逻辑不变，使用 classification.lastError
```

删除笼统文案「补拉结果未返回 repaired」。

- [x] **Step 3: Commit（仅当用户要求时）**

```bash
git add mail-guide-ai-main/supabase/functions/sync-mailbox/index.ts \
  mail-guide-ai-main/supabase/functions/run-email-attachment-repair-tasks/index.ts
git commit -m "$(cat <<'EOF'
fix(mail): surface attachment repair failures instead of silent skip

EOF
)"
```

---

### Task 4: 补拉路径优先用户附件 part（可选加固）

**Files:**
- Modify: `mail-guide-ai-main/supabase/functions/sync-mailbox/index.ts`（`repairAttachmentsForRecord` 内循环）

- [x] **Step 1: part 循环时 user 优先、inline 一并拉**

现有 `parseAttachmentPartSections` 已返回全部 part。保持全部 FETCH（保证正文 cid 图），无需过滤；count 已只计 user。

若担心超时：先拉 `kind === "user"`，时间预算内再拉 `inline`。最小改动：

```typescript
  const partSections = parseAttachmentPartSections(metaRaw);
  const ordered = [
    ...partSections.filter((s) => s.kind === "user"),
    ...partSections.filter((s) => s.kind === "inline"),
  ];
  for (const sec of ordered) {
    // 现有 fetchBodyPart 逻辑不变
  }
```

- [x] **Step 2: Deno 测试仍 PASS**

```bash
deno test _shared/imap-bodystructure.test.ts
```

---

### Task 5: 规格状态 + 手工验收清单

**Files:**
- Modify: `docs/superpowers/specs/2026-07-14-inbound-attachment-count-and-repair-design.md`（状态 → 已批准）

- [x] **Step 1: 更新 spec 状态为「已批准（2026-07-14）」**

- [x] **Step 2: 手工验收（部署 functions 后）**

1. 同步/打开 Gmail「2 附属品、各 ~1MB」邮件 → 工作台显示约 **2** 个待补拉或已可下载（非 6）。
2. 对历史「约 6 / 第 N 次」邮件点补拉或等 cron → 体积未超限时应出现预览；任务 `last_error` 非空转文案。
3. （可选）超大附件仍排队，错误含体积相关 reason。

部署提示（自建）：同步 Edge Functions 后重启 `functions` 服务；无需 migration。

---

## Spec coverage check

| Spec 项 | Task |
|---------|------|
| §2.1 / §3.2 / §3.3 用户附件定义与 count | Task 1–2 |
| §2.2 / §3.4 去掉 count≥3 门闸 | Task 2 |
| §3.5 auto inline 3MB | Task 2 |
| §3.6 repair_full + worker 透传 | Task 3 |
| §5.1 Deno 单测 | Task 1 |
| 内嵌仍可补拉 | Task 1 + 4 |
| 前端文案沿用 count | 无需改（后端写准 count） |

---

## Execution notes

- 用户规则：**未明确要求时不要 git commit**；计划中的 Commit 步骤默认跳过，除非用户说「提交」。
- 实现后需部署 `sync-mailbox` 与 `run-email-attachment-repair-tasks` 才对运行中环境生效。

---

## 手工验收（部署后）

- [ ] 同步/打开 Gmail「2 附属品、各 ~1MB」邮件 → 工作台显示约 **2** 个待补拉（非 6）；补拉后可下载
- [ ] 历史「约 6 / 第 N 次」邮件 → 点补拉或等 cron，体积未超限时应成功；`last_error` 为具体原因（非空转文案）
- [ ] 真正超大附件 → 仍排队，`last_error` / `queue_reason` 含体积相关 reason
- **部署提示（自建）**：同步 Edge Functions `sync-mailbox` + `run-email-attachment-repair-tasks`，重启 `functions` 服务；**无需 migration**
