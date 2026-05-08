---
name: zh-project-analysis
description: >-
  Conducts technical analysis and explanations primarily in Chinese, grounded in
  this repository's Vite, React, TypeScript, shadcn/Radix, Tailwind, TanStack
  Query, React Router, Supabase, Edge Functions, and Vitest conventions. Use
  when the user writes in Chinese, asks for 分析/评审/方案/梳理, or requests
  responses tied to this project's code, architecture, data model, or workflows.
---

# 中文 + 项目结合的分析

## 用户约定（原文）

以中文为主要语言，结合项目，分析技能

## 何时启用

- 用户使用中文提问，且涉及理解、评审、方案、排错、影响面、风险或实现建议时。
- 用户明确要求结合本仓库、本模块或现有实现时。

## 语言与表达

- **主语言**：简体中文撰写结论、步骤说明与讨论；代码标识符、路径、类型名、API 名保持原文（英文）。
- 必要时在括号内对英文术语给出简短中文释义，避免整段英文化。

## 结合项目的做法

在给出分析前，**先基于本仓库取证**，避免泛泛而谈：

1. **栈与脚本**：查看 `package.json`，默认认为项目是 Vite + React 18 + TypeScript，脚本包括 `dev`、`build`、`lint`、`test`、`commit:check`、`changelog`、`release:*`。
2. **前端入口**：从 `src/App.tsx` 理解路由，当前核心页面包括 `Workbench`、`Mailboxes`、`Shops`、`Erp`、`Templates`、`Users`、`SendLogs`、`RiskLogs`。
3. **UI 与状态**：优先沿用 shadcn/Radix 组件、Tailwind 工具类、`@/components/ui/*`、`@/lib/utils`、React Router、TanStack Query、`sonner`/toast 的现有风格。
4. **认证与权限**：涉及页面访问、管理员能力或会话时，查看 `src/components/ProtectedRoute.tsx`、`src/hooks/useAuth.ts` 和 Supabase Auth 调用。
5. **Supabase 客户端**：前端数据访问优先从 `src/integrations/supabase/client.ts` 与自动生成的 `src/integrations/supabase/types.ts` 取证；不要手写与生成类型冲突的表结构。
6. **后端与数据**：涉及邮件同步、AI 草稿、发送回复、Shopify、风控、补偿任务时，查看 `supabase/functions/` 与 `supabase/migrations/` 中的真实 Edge Function 行为、RLS、表结构和约束。
7. **业务模块**：围绕客服邮件自动化分析时，重点关注 mailbox/email/draft/send log/risk log/template/shop/user/ERP/Shopify 相关页面、函数和迁移。

使用工具读取相关文件后再下结论；若信息不足，用中文说明缺口并指出应打开的路径或应运行的命令。

## 技术栈速查

- **应用框架**：Vite、React 18、TypeScript、React Router。
- **UI**：shadcn 风格组件、Radix UI、Tailwind CSS、`class-variance-authority`、`tailwind-merge`、`lucide-react`。
- **数据与状态**：Supabase JS、TanStack Query、React Hook Form、Zod。
- **后端能力**：Supabase Edge Functions、SQL migrations、Supabase Auth、RLS。
- **测试与质量**：Vitest、Testing Library、ESLint、TypeScript。
- **业务集成**：客服邮件处理、SMTP/邮箱同步、AI 草稿、Shopify 订单/履约、ERP、风控拦截、补偿任务。

## 分析重点

- **实现方案**：优先复用现有页面、hook、lib、Edge Function、迁移和类型；只有在重复逻辑明确或边界复杂时才建议新增抽象。
- **数据一致性**：涉及发送、同步、补偿、风控时，检查幂等键、状态流转、错误记录、重试、RLS 和数据库约束。
- **前后端契约**：对比前端调用参数、Supabase 类型、迁移字段和 Edge Function 返回值，指出不一致风险。
- **用户体验**：结合当前 shadcn/Radix/Tailwind 组件风格，关注 loading、empty、error、权限不足和操作确认状态。
- **测试建议**：窄改动优先建议 Vitest 单测；跨模块或业务状态机改动建议覆盖关键路径与边界条件。

## 常用验证命令

按改动范围选择，不要无意义地全量运行：

- `npm run lint`
- `npm run test`
- `npm run build`
- `npm run commit:check`

## 分析输出建议结构

按需选用，保持简洁：

1. **结论摘要**（一两句）
2. **依据**（对应文件/模块/表/函数，用反引号路径或代码引用）
3. **项目语境**（该问题在 Vite/React/Supabase/Edge Function/数据库中的落点）
4. **影响与风险**（边界情况、权限、数据一致性、回滚/重试等）
5. **验证建议**（应运行的脚本或应补的测试）
6. **可选行动项**（具体、可执行；不扩大用户未要求的改动范围）

## 不要做的事

- 不要用大段英文替代中文说明（除非用户明确要求英文）。
- 不要脱离本仓库虚构目录、表名或脚本。
- 不要把 shadcn/Radix/Tailwind/Supabase 的通用教程当作项目结论；必须落到本仓库文件与业务流。
- 不要直接编辑自动生成文件（如 `src/integrations/supabase/types.ts`），除非用户明确要求并说明生成来源。
- 不要为「显得专业」而冗长；默认读者熟悉本项目语境。
