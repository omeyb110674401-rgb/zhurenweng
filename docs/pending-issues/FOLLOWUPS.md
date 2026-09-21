# 后续议题登记（durable）

**为什么有这个文件**：`docs/pending-issues/*.md` 是「GitHub 停用期间」的临时载体 ——
按 README 的约定，补录到 tracker 后这些文件会被删除。而各 issue 的「未做（有意）」小节里
既有**真实待办**也有**有意不做的判断**，删文件会把它们一起带走（评审 issue #50 指出的
「遗留项没有落脚点」）。凡是写进各 issue「未做」小节、且**将来可能要做**的，登记在这里；
纯属「有意不做」的取舍也简列，免得以后被当成遗漏重新讨论一遍。

## 一、待用户决定（阻塞，未开工）

| 事项 | 说明 |
| --- | --- |
| GitHub 账号处置 | 2026-09-21 起账号 `omeyb110674401-rgb` 被停用（`git push` 403、仓库页与 codeload 404），已申诉。处置方向（等申诉结果 / 迁 Gitee / 自建 Gitea / 保持现状）未定 → 决定后推送积压提交并恢复 `deploy-NN.sh` 那条通道 |
| AI 摘要服务商 | PRD 第 49 条要求用已备案的国产模型。默认 `LLM_PROVIDER=glm` 需 `GLM_API_KEY`（填在服务器 `.env`，不进仓库、不进对话）；摘要区现在按 #22 的门控显示「暂未启用」 |
| SMTP 凭据 | 未配置 → 订阅入口按 #17 门控隐藏、截止提醒不发信。凭据填服务器 `.env` |
| 机器点击清理 | 库内 46 行疑似机器点击（`/root/cleanup-machine-clicks.sql` 已就位）。**生产数据删除需用户明确同意**，未执行 |
| moe 源 20 条归档条目 | 该源改版后旧条目已不可达，是否清理未定 |
| `govcn` 死源行 | sources 表里已停用的行，是否删除未定 |

## 二、已记为后续的工程项

| 来源 | 事项 | 现状 / 触发条件 |
| --- | --- | --- |
| #44 | **内容变更时间字段**：sitemap 的 `lastmod` 现用发布日期（对 99% 条目就是真值，且只说「旧」不说「新」）；严格口径需要给 `notices` 加一列内容变更时间（迁移 + upsert 比较 + 测试） | 未做。等「补抓正文」这类场景变多再做 |
| #44 | `error.tsx` | 未做：没有触发路径（探针全 200/404）。等真的出现 500（如库不可用）再加 —— 那时才知道文案该说什么 |
| #47 | 公示期分布改为 SQL 侧聚合 | 未做：178 行量级，应用层一次分组足够。数据量变大时可直接复用 `periodDaysExpr` |
| #49 / #50 | 统计页 `Dataset`、站内 `WebSite` + `SearchAction` 结构化数据 | 未做：搜索页是 noindex（#38），声明一个不该被收录的入口收益不明 |
| #49 | 把 `stripSsrComments` 的局部 wrapper 从各 e2e 彻底删掉 | 部分完成：#50 删掉了 `status-freshness` 里那处重复 wrapper；其余文件仍保留同名局部函数（改动面 vs 收益不划算） |
| #50 | 复合机关 + 空 `agency_keys` 的钻取兜底 | 未做：线上 16 行机关全部满足「点进去的条数 = 表格数字」（合计 178），不存在此类行。**触发条件**：若表格数字比点进去多 1，按 `agency LIKE '牵头机关、%'` 补一条兜底 |
| #50 | `?period=` 在 PG 侧遇坏日期会抛 500（SQLite 侧静默 0 行） | 已收口：所有适配器与后台写入路径的日期都过 `normalizeDateText`（回读校验），坏日期进不了库，因此不加方言专属形状守卫 |
| #51 | **Dockerfile 单阶段 + 以 root 运行**：web 镜像里同时装着 devDependencies（tsc / eslint / drizzle-kit），容器进程是 root | 未做：瘦身与降权是真实收益，但改动面与部署风险不成比例。要做就一起做（多阶段 + `USER node` + 只在最终层装生产依赖） |
| #51 | **健康检查缺失**：`docs/deploy.md` 让操作者「五服务应为 healthy」，实际只有 db 有 healthcheck，也没有 `/api/health` 端点；`web.depends_on.meilisearch` 用的是 `service_started` | 未做：加它要先定「健康」的判据（库可写？检索可达？）—— 定下来之后是十几行的事 |
| #51 | **表增长无上限**：`outbound_click_daily` / `alert_sends` / `reminder_sends` 只增不删；`sitemap.ts` 与 `reindexAllNotices` 一次性载入全表（含正文）并整表推给 Meilisearch | 未做：184 条量级无碍。量级变大时先做「点击按日聚合保留 N 天」与 reindex 分批 |
| #51 | **npm audit 4 个 moderate** | 不修：全部来自 `drizzle-kit → @esbuild-kit/esm-loader → esbuild`（dev-only，容器内不可达），`fixAvailable` 是降级到 `drizzle-kit@0.18`（会破坏配置）。等上游升级 |
| #51 | **tsconfig 严格度**：`noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` / `noImplicitOverride` / `noFallthroughCasesInSwitch` / `noUnusedLocals` 均未开 | 未做：审计未发现现存缺陷（现有索引访问都有守卫），开启需要成片改动。值得单开一轮做 |
| #51 | **提醒邮件「先发后记」的跨进程双发窗口** | 有意保留：at-least-once（重复提醒比漏提醒可接受），跨进程由「单实例部署 + worker 重入保护」覆盖。若将来要多副本，改成 claim-first（先占位再发） |

## 三、有意不做（by design，别当成遗漏）

- **附件链接**（#35）：不隐藏 / 不改写被 WAF 拦的工信部附件链接；不在抓取期探测附件可达性
  （我们机房 IP 403 不代表用户 403；且每轮多出上百请求，不礼貌）。
- **容器不加 `TZ`**（#40）：日历口径写进代码（`Asia/Shanghai`），不依赖部署环境变量。
- **不回填历史 `click_date`**（#40）：指标数据不是业务数据，回填等于改写历史统计。
- **`/stats` 不加 canonical、任何页面不加 `robots.txt` Disallow**（#41）：Disallow 会让爬虫
  读不到 noindex，反而不如现在（可爬 + 不收录 + follow 链接）。
- **不给库内 `status` 列做展示层以外的改动**（#43）：它是抓取口径的缓存，改它要连带动
  upsert、列表排序与提醒任务；展示层用 `effectiveStatus` 复核已解决读者看到的问题。
- **不缩短抓取频率**（#43）：把状态窗口从 14 小时缩到 1 小时需要对十个政府站点每小时抓一轮，
  不礼貌；展示层复核的收益/代价比明显更好。
- **版本链不因缺正文摘链**（#42）：链关系是真的，缺的只是正文。
- **趋势表的机关行头不做链接**（#45）：行「小计」是窗口内的和、与上方表格的全时段数字不同，
  做成链接容易让人以为「点进去就是这个数字」。
- **`/diff` 与 `/search` 不加 canonical**（#42 / #38）：noindex 页不需要自指 canonical，且写
  `alternates` 会覆盖 layout 的 RSS 自动发现（#41 的教训）。
