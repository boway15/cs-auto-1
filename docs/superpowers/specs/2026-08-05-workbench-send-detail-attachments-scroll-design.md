# 工作台发送详情：出站附件 + 弹窗滚动 — 产品设计规格

**日期**：2026-08-05  
**状态**：已批准并实现（2026-08-05）  
**范围**：`mail-guide-ai-main` 工作台往来「发送详情」与发送日志「发送详情」弹窗

---

## 1. 背景与目标

### 1.1 现状

| 位置 | 出站附件 | 弹窗过高时滚动 |
|------|----------|----------------|
| 发送日志 `/send-logs` 详情弹窗 | 有：`metadata.attachments` → `outbound-attachments` 预览/下载 | 无整体 `max-h`；仅正文 `ScrollArea h-48` |
| 工作台「同发件人与收件人往来」发件详情 | 无：查询未含 `metadata`，UI 无附件区 | 同上 |

### 1.2 目标

1. 工作台发件详情弹窗与发送日志对齐，展示出站附件预览/下载。
2. 两处「发送详情」弹窗在内容过高时支持整体滚动。

### 1.3 已确认产品决策

- **附件展示范围**：仅发件详情弹窗（不对往来列表加回形针等标识）。
- **滚动范围**：工作台与发送日志两处弹窗统一处理。
- **实现路径**：方案 1 — 抽取共享附件组件，避免两套 UI 漂移。

### 1.4 明确不做

- 往来列表行附件标识
- 历史入站行附件展示（仍走当前邮件详情区）
- 后端 / migration / Edge Functions 变更
- 将整页「发送详情」元数据区合并为单一 Dialog 组件（字段不完全一致）

---

## 2. 架构与数据流

```
email_send_logs.metadata.attachments
        │
        ▼
parseSendLogOutboundAttachments()     （已有 outbound-attachments.ts）
        │
        ▼
signSendLogOutboundAttachmentUrls()   （已有）
        │
        ▼
SendLogDetailAttachments              （新建共享组件）
        │
        ├── SendLogs.tsx 发送详情弹窗
        └── EmailPairHistoryList.tsx 发送详情弹窗
```

工作台数据链路：

1. `WORKBENCH_SEND_LOG_SELECT` 增加 `metadata`
2. `WorkbenchSendLog` 类型增加 `metadata: unknown`（或与发送日志一致的宽松 JSON 类型）
3. 打开详情时，共享组件根据 `metadata` 解析并签名展示

---

## 3. 组件设计

### 3.1 `SendLogDetailAttachments`

**路径**：`mail-guide-ai-main/src/components/SendLogDetailAttachments.tsx`

**Props**：

| 属性 | 类型 | 说明 |
|------|------|------|
| `metadata` | `unknown` \| `null` \| `undefined` | 发送日志 `metadata` 字段 |

**行为**（从 `SendLogs.tsx` 迁出，保持现有交互）：

- 用 `parseSendLogOutboundAttachments` 解析；无附件时渲染 `null`
- `useEffect` 按附件列表签名 `outbound-attachments`，生成 preview/download URL
- 展示：文件名、MIME、下载按钮；图片 `max-h-48` 预览；失败提示「文件已清理或无权访问」
- 加载中显示「正在加载附件链接…」

**接入**：

- `SendLogs.tsx`：删除本地附件 state/`useEffect`/JSX，改为 `<SendLogDetailAttachments metadata={detail.metadata} />`
- `EmailPairHistoryList.tsx`：在正文与错误信息之间插入同一组件

### 3.2 弹窗滚动

两处 `DialogContent` className 统一为：

```
max-w-2xl max-h-[85vh] overflow-y-auto
```

与仓库内 `AutoReplyTemplates` / `QuickReplyTemplatesTab` 等模式一致。

正文区保留现有 `ScrollArea className="h-48"`（嵌套滚动可接受：外层滚整体，内层滚长正文）。

---

## 4. 文件变更清单

| 文件 | 变更 |
|------|------|
| `src/lib/workbench-send-logs.ts` | `WorkbenchSendLog` + `WORKBENCH_SEND_LOG_SELECT` 增加 `metadata` |
| `src/components/SendLogDetailAttachments.tsx` | **新建**共享附件区 |
| `src/pages/SendLogs.tsx` | 改用共享组件；`DialogContent` 加滚动约束 |
| `src/components/EmailPairHistoryList.tsx` | 接入共享组件；`DialogContent` 加滚动约束 |

无 SQL / Edge Function / 环境变量变更。

---

## 5. 错误处理

| 场景 | 行为 |
|------|------|
| `metadata` 无 `attachments` 或为空 | 不渲染附件区 |
| Storage 签名失败 / 文件已清理 | 单附件显示既有失败文案，不影响其它附件与弹窗其它字段 |
| 工作台查询含 `metadata` 失败 | 沿用现有 `fetchWorkbenchSendLogsForEmails` 错误返回路径（不单独降级） |

---

## 6. 验收标准

1. 工作台打开带出站附件的发送详情：附件列表、图片预览、下载与发送日志页一致。
2. 无附件的发送记录：详情弹窗无附件区，行为与现在一致。
3. 发送日志页：附件功能不回退；弹窗内容超过视口高度时可整体滚动查看底部附件/错误信息。
4. 工作台发送详情：同样可整体滚动。
5. 不改往来列表行 UI；不引入后端变更。

---

## 7. 测试建议

- 手工：对同一条含图片 + 非图片附件的 `email_send_logs`，分别在 `/send-logs` 与工作台往来中打开详情，对比展示与下载。
- 手工：用超长正文 + 多图附件撑高弹窗，确认可滚到底部。
- 若有既有 Vitest：可为 `parseSendLogOutboundAttachments` 保持既有覆盖即可（本需求不强制新增单测）。
