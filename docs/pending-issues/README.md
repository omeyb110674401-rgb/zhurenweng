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
| `46-period-bucket-label-and-gap.md` | 公示期分布的桶标签重叠，且「少掉的那几条」不给数字 | `743ce98` |
| `47-period-bucket-drilldown.md` | 公示期分布的桶不可钻取（页面上最后一处点不开的数字） | `b37b20c` |
| `48-trend-range-drilldown.md` | 趋势表的小计与总计点不开（求和结果缺区间口径） | `03cedd9` |
| `49-e2e-html-helper-and-itemlist.md` | e2e 解析器收成共享工具 + 首页 ItemList 结构化数据 | `17e6314` |
| `50-code-review-and-fixes.md` | 全量代码评审（规范 + 规格两轴）与 11 项修复：牵头口径在筛选表单里丢失、邮件 href 未转义、stats.ts 的裸 NUL 字节让文件不可评审、多词搜索三路径三语义 | `b92493c` |
| `51-code-health-and-robustness.md` | 代码健康与健壮性审计（第二轮）与 13 项修复：.env 曾烘进 web 镜像层、PG 连接池无超时、worker 重入与优雅退出、源数据质量降级不再静默 | `7261aa2` |
| `52-security-review.md` | 安全与滥用面审计（第三轮）与 11 项修复：抓取器可被源站指挥去打内网（详情 URL 与重定向目标无约束）、订阅端点无限流且确认链接 GET 即写库、后台会话 Cookie 无 Secure 且全站无安全头、`?token=` 长期留在 URL 里 | `c82fc6b` |
| `53-frontend-ux.md` | 前端体验（第四轮）与 8 组改进：全站零媒体查询与零图标资产、备案号只在 3 个页面（合规缺口）、零 skip link、订阅表单失败丢已填内容、`/go` 死路回裸 JSON；顺带抓到「文件约定的 og:image 会被页面级 openGraph 覆盖」与「同步脚本静默改坏二进制」 | `e8da8d5` |
| `54-live-site-audit.md` | 线上体检（第五轮，以生产实测为准）与 9 项修复：分页边界重复一条并挤掉一条（排序缺唯一键）、404 页被构建期预渲染导致备案号显示成占位且订阅入口该隐藏未隐藏、JSON-LD `numberOfItems` 与「共 N 条」矛盾、全站文案承诺未启用的 AI 摘要、根目录静态资源每次回源、错误响应丢 `X-Robots-Tag`；并记下「源码审计给出的两条 SEO 结论被线上否掉」与「回归用例修复前也通过」两条教训 | （本轮） |
| `55-ai-summary-and-smtp.md` | AI 摘要与邮件订阅上线（第六轮）：`SMTP_SECURE=true` 被读成「不要直连」的静默错配（`.env.example` 与生产值都是错的）、`.env` 幂等写入与「密钥不上命令行」两个运维脚本、AI 摘要临时走 opencode-go 境外网关（mimo-v2.5 实测 87.6s/次，超时因此从 120s 提到 300s）、订阅全链路生产实测（含一键退订与退订后重订）、云主机封 25 端口的实测；合规债与发信量短板明确挂账 | （本轮） |
| `56-summary-content-reframe.md` | 摘要内容重构为「参与导引」：实测抓取到的正文均值仅 443 字（草案条文都在附件里），据此删掉必然产出伪信息的「关键条款」，改为谁能提 / 逾期会怎样 / 可点渠道清单；顺带修掉「空段能落库」的校验不对称（线上真有一条空的「影响谁」）；新形状上线后发现摘要卡与 #27 的抽取块把同一个邮箱渲染了两遍，因此渠道改为**一处渲染、两个来源**（程序抽取权威 + 摘要补充，按值判重并逐行标出处）；并给出附件解析（B 路线）的可行性实测 —— 60 页 PDF 抽出 5 万字，但 miit 附件主机 100% 403 且换头换 IP 都无效 | （本轮） |

**另有 `FOLLOWUPS.md`（durable，不随本目录删除）**：各 issue 的「未做（有意）」小节里
既有真实待办也有有意取舍，都登记在那里 —— 本目录按约定会在补录 tracker 后删除，删文件
不该把「将来可能要做的事」一起带走（issue #50 指出的「遗留项没有落脚点」）。

同时 `origin/main` 之后的全部提交（issue #33 起，含 #39）都已提交但未推送 —— 恢复
推送通道后一并推送（数量随迭代增长，当前值看 `git rev-list --count origin/main..HEAD`）。
