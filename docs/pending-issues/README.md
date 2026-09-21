# 待提交的 issue（GitHub 账号停用期间）

2026-09-21 起 GitHub 账号 `omeyb110674401-rgb` 被停用（`git push` 403、仓库页与
codeload 404），**无法创建 issue**。停用期间新工作的 issue 正文先落在这里，
账号恢复（或换托管）后按文件名编号补录到 tracker，然后删除本目录下的对应文件。

| 文件 | 标题 | 对应提交 |
| --- | --- | --- |
| `35-attachment-and-timeline-audit.md` | 审计：附件链接有效性与发稿时间线（含附件块出路提示） | `f3e6787` |
| `36-stats-drilldown-and-lead-agency.md` | 统计页缺钻取入口，且机关口径与筛选不一致 | `5739d2c` |
| `37-mail-escaping-and-mobile-tables.md` | 邮件 HTML 未转义 + 统计页宽表在窄屏撑破整页 | `a31025c` |
| `38-indexability-and-go-headers.md` | 搜索结果页与退订页可被收录；/go 端点缺缓存与索引声明 | `4ea2004` |
| `39-jsonld-and-filter-interaction.md` | 详情页加 JSON-LD 结构化数据；首页机关下拉与筛选值不一致 | `2386082` |
| `40-site-calendar-timezone.md` | 「今天」按进程时区算：容器跑 UTC，北京时间凌晨 8 小时里倒计时/状态/点击日归属全错一天 | `b1035d5` |
| `41-list-view-indexability.md` | 列表页的 URL 变体没有索引口径：首页可被无界 querystring 灌薄页（分页也无 canonical） | `648cf09` |
| `42-diff-incomplete-body.md` | 版本对比在单侧缺正文时把上一版整篇报成「删除」 | `3017a5d` |
| `43-stale-status-badge.md` | 状态列每日一轮，过期条目在下一轮抓取前仍显示「征求意见中」 | `49e3b83` |
| `44-sitemap-lastmod.md` | sitemap 的 lastmod 写成了抓取时间：178 条全部声称「今天改过」 | `3817eed` |
| `45-trend-month-drilldown.md` | 统计页月度趋势表的数字全是死文本：缺的是「按月份」筛选口径 | `2c896f6` |

同时 `origin/main` 之后的全部提交（issue #33 起，含 #39）都已提交但未推送 —— 恢复
推送通道后一并推送（数量随迭代增长，当前值看 `git rev-list --count origin/main..HEAD`）。
