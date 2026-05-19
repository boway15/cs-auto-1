# 版本号策略（SemVer）

本项目采用 **语义化版本** `主版本.次版本.修订号`（`MAJOR.MINOR.PATCH`）。

## 1.0.0 封板

- **1.0.0** 为功能封板基线，代码与部署文档以该标签为准。
- 后续迭代在 `main`（或约定发布分支）上通过 `mail-guide-ai-main` 内脚本发版：
  - Bug 修复：`npm run release:patch` → 第三位 +1（如 `1.0.1`）
  - 功能新增/增强：`npm run release:minor` → 第二位 +1、第三位归零（如 `1.1.0`）
  - 不兼容变更：`npm run release:major` → 第一位 +1（如 `2.0.0`，需团队评审）

## 发版命令

在 `mail-guide-ai-main` 目录下，工作区须干净：

```bash
npm run release:patch   # 1.0.0 → 1.0.1
npm run release:minor   # 1.0.0 → 1.1.0
npm run release:major   # 1.0.0 → 2.0.0
```

脚本会更新 `package.json`、`CHANGELOG.md`、创建 `chore(release): vX.Y.Z` 提交并打 Git 标签 `vX.Y.Z`。推送时使用：

```bash
git push origin HEAD --follow-tags
```

## 与镜像/部署的关系

- 前端 Docker 镜像、运维手册中的「当前版本」应与 `package.json` 的 `version` 及 Git 标签 `v*` 保持一致。
- 热修复仅改 Edge Functions 或 Dify 工作流时，仍建议 bump **patch** 并打标签，便于回滚与对账。
