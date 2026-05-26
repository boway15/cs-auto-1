# 运维角色使用说明

在 Cursor 中为本仓库配置了 **专职运维角色**，用于每次 **提交代码** 和 **发版** 前的核对，避免漏 SQL/Functions、误提交数据卷或密钥。

## 三种启用方式（任选）

| 方式 | 用法 |
|------|------|
| **子代理（推荐）** | 在 Agent 输入框输入：`/mail-guide-ops 检查本次提交` 或 `/mail-guide-ops 准备 v1.0.3 发版` |
| **自然语言** | 「用运维角色检查 git 变更」「发版前帮我核对 backend-release.env」 |
| **规则** | 在 Cursor Rules 中启用 **「运维角色：提交与发版…」**（`cs-main-ops-role`） |

子代理定义：`.cursor/agents/mail-guide-ops.md`  
技能定义：`.cursor/skills/cs-main-ops-role/SKILL.md`

## 常用话术

**提交前：**

```text
/mail-guide-ops 根据当前 git 变更做提交前检查，给出 commit message 和是否需要改 backend-release.env
```

**发版前：**

```text
/mail-guide-ops 版本 v1.0.3：核对 backend-release.env、Jenkins rsync 项和线上验收命令
```

**发版后验收：**

```text
/mail-guide-ops 发版已完成，给我 post-deploy 验收步骤和漏项对照
```

**发给线上运维的上线说明（标准格式）：**

```text
/mail-guide-ops 输出 v1.2.0 发给运维的发版文档
```

输出遵循 `docs/ops-release-notice-template.md`（五步：rsync → 后端脚本 → 环境变量 → 前端 → 验收）。

## 你会得到什么

**提交/发版核对**（模式 A/B）固定五段输出（中文）：

**运维发版文档**（模式 C）：完整可转发的上线说明 Markdown（见 `docs/ops-release-notice-template.md`）。

1. 变更摘要  
2. 提交/发版检查表（`- [ ]`）  
3. `backend-release.env` 建议片段（若有后端变更）  
4. 可复制命令（git / Jenkins / docker / psql）  
5. 风险与漏项提示  

## 与研发角色的分工

| 角色 | 适用 |
|------|------|
| 默认 Agent / `mail-guide-ai-dev` | 写功能、改页面、Edge Function 业务逻辑 |
| **`/mail-guide-ops`** | 提交归类、发版清单、Jenkins、验收、禁提交项 |

## 相关文档

- [backend-release-automation.md](./backend-release-automation.md)
- [ops-post-deploy-checklist.md](./ops-post-deploy-checklist.md)
- [ops-handbook-selfhosted-supabase-centos.md](./ops-handbook-selfhosted-supabase-centos.md)
