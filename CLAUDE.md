# CLAUDE.md

## 项目

**主人翁**（zhurenweng）——政府公示与征求意见信息聚合网站。把分散在官方渠道的国家级公示/征求意见稿聚合起来，用 AI 摘要帮助公众「发现 → 读懂 → 行动」，行动指引导用户回到官方渠道提交意见（北极星指标：出站提意点击数）。

项目背景与决策记录见 `docs/agents/`；PRD 位于 `docs/prd.md`（由 /to-prd 生成）。

## 环境

- OS: Windows 10，shell 为 Git Bash —— 用 Unix 语法与正斜杠路径
- Node.js v24 / npm（global prefix: `D:\npm-global`）、Python 3.14
- 远程仓库在 GitHub，gh CLI 已登录（账号 `omeyb110674401-rgb`，SSH 协议）

## 约定

- 动手探索前先读 `CONTEXT.md` 与 `docs/adr/`（如尚不存在则静默继续）
- 所有任务 issue 走 GitHub Issues，规则见 `docs/agents/issue-tracker.md`
- 政务信息聚合 + AI 生成内容属敏感面：只聚合官方公开信息、必须注明出处、AI 摘要必须显著标注

## Agent skills

### Issue tracker

GitHub Issues；外部 PR 也作为 triage 请求面。 See `docs/agents/issue-tracker.md`.

### Triage labels

五个规范角色使用默认标签字符串（needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix）。 See `docs/agents/triage-labels.md`.

### Domain docs

Single-context：根级 `CONTEXT.md` + `docs/adr/`。 See `docs/agents/domain.md`.
