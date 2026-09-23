# 58 · 间歇性慢源的信号降噪 + 死源清理 + 摘要文案诚实化

起因是 2026-09-23 的一次线上实测（数据当场抓取）。报告里四条现象看着像"源站不行"，
逐条查下来全都是**我们把信号写成了噪声**：真出事与例行抖动在看板和信箱里长得一模一样，
而界面对着一件不会发生的事承诺"正在做"。

## 一、四条现象与它们的根因

| 现象 | 根因（不是源站的错） |
| --- | --- |
| `npc` 每天红一次、每天一封「源抓取失败」邮件 | 失败**一次**即 `healthy=0`（`worker/jobs/crawl-notices.ts` → `recordSourceFailure`），而成功后**不清错误列**，告警去重窗口只有一个日历日 ⇒ 间歇性慢源永远不收敛 |
| 后台的「按源调度」看起来能配 | `sources.schedule_config_json` 是**幽灵旋钮**：两方言都有列，repo 每次只写 `'{}'`，抓取任务从不读，没有任何源用过 |
| 已截止条目的详情页永远写着「摘要生成中」 | 详情页按 `summary_status='pending'` 渲染进行时，而摘要任务的入队条件按 #4 的设计**排除已截止条目** ⇒ 库里 108 条被永久承诺一个不会兑现的动作 |
| 后台永远显示一个红着的空源 | `sources` 表里 `govcn` 是注册表已删适配器留下的死行（`enabled=1`、`healthy=0`、0 条目、错误停在 2026-09-20 的 HTTP 404） |

**目标**：真出事仍然当天看得见，抖动不再变成日常噪声；顺手清掉假旋钮与死行；让摘要文案不
再撒谎。噪声的日常化比漏报更糟 —— 它会训练人跳过那封邮件。

## 二、先立证据：三条被实测否掉的前提（别照抄直觉）

写代码前先做实验，三条"看起来是缺陷"的判断被现场否掉：

1. **「`AbortSignal.timeout` 只管表头，不管响应体」是错的。** Node 24 实测：服务端只
   `write()` 不 `end()`（headers 181ms 到），客户端 `read()` 在 1519ms 抛 `TimeoutError`；
   另一种"连表头都不发"同样在预算点抛。⇒ 同一个 signal 已经覆盖读体，**不需要**给读循环
   另加第二个计时器。该实验固化成回归用例（`crawl-timeout-guard.test.mjs` 第二条）。
2. **「把每跳的预算合并成一个总预算」本轮不做。** 每跳一个新 signal ⇒ 最坏耗时按跳数乘倍
   （`MAX_REDIRECT_HOPS=5`）。今天能过 15s×N 的 `moj` 一旦合并成单预算会整源退化 ——
   收益不明、风险确定，记入「未做」。
3. **`alerts.ts` 的日历日去重窗口不是缺陷。** 拉到 7 天无法区分「还挂着」与「恢复了又坏了」；
   能区分的是**计数器**，所以跨轮判断落在新增的 `consecutive_failures`，去重窗口不动。

## 三、按源超时：走代码，不走数据库

`SourceFetchOptions` 增 `timeoutMs`（与既有 `cookieChallenge` 同一个接缝 —— 本站特有的传输
要求集中在抓取层一处），`npc` 声明 30s；全局值改为 `CRAWL_TIMEOUT_MS`（`envInt`，非法值启动
即报错）。生效预算按 **显式传参 > 适配器声明 > 全局缺省** 一处解析（`crawlTimeoutMs`），
挂 signal 与写错误消息用的是同一个数。

**为什么不接 DB**：后台只有启用/停用、没有编辑入口，DB 驱动的按源配置必然长成
`schedule_config_json` 今天的下场 —— 「要一次性 SQL 才能生效，生效后没有任何东西证明它还被读着」。
因此该列**删除**，按源配置只走代码。

超时错误改写为可归因形式：`抓取超时（>30000ms 未取完响应体）：<url>（…）`。刻意**不动**
`readCappedBuffer`：它被附件整档复用（#57），里面写死数字会打花刚上线的抽取成功率基线。

## 四、健康度：判据、状态、决策各在一处

三根轴不再混在一个函数里：`src/lib/source-health.ts` 只放**判据**（新增 `isSourceUnhealthy`、
`shouldAlertForSourceFailure`，与既有 `isSourceDegraded` 并列 —— 后者看「一轮内坏多少」，
新两个看「跨轮连着坏了多久」，正交）；`src/db/repo/sources.ts` 只放**状态与落库**；
`crawl-notices.ts` 只做**决策与发信**。

`upsertSource` 那个「一个函数两用」拆成三个诚实入口。原来的问题不是命名，是**假绿窗口**：
轮初拿它乐观写 `healthy=true`，而 `recordSourceFailure` 在调用点带 `.catch(() => {})` ——
那条写一旦失败被吞掉，源就整天假绿。现在是：

- `registerSource`：只保证行存在（外键前提），**不碰健康、计数与错误列**；
- `recordSourceSuccess`：判健康、计数归零、**清掉当前故障态的错误列**、记成功时间；
- `recordSourceFailure`：计数 +1，按门槛决定这一行是否判红，返回
  `{consecutiveFailures, unhealthy, previousErrorMessage}`；降级路径（#51 的「一轮内过半条目
  失败」）传 `immediateUnhealthy` 把计数钳到门槛 —— 那是事件不是抖动，不该被两轮门吞掉。

**与「成功不清错误列」这条既有决定的调和**：它当时的理由是「便于排查曾停摆的源」，实现却把
「当前有没有事」和「上次出了什么事」压进同一对列，于是看板永远像正在出事。现在这两列只描述
当前故障态；历史不丢 —— worker 日志与告警邮件每轮都带原因，第二封邮件里还明确写着
`（上一轮：<first error>）`，那正是原决定想要的排查线索，只是不再常驻界面。

## 五、告警降噪与它的补偿

首轮抖动**只记不发**；第 2 轮必发（真出事最坏晚一天）；此后每 7 轮重发一次封顶
（`n === 2 || (n - 2) % 7 === 0`）；降级路径保持今天就发；恢复不发信。

补偿是看板新增的 `连续失败` 列（`data-field="recent-failures"`），首轮失败显示
`连续 1 轮（满 2 轮判异常）`。这是「首轮失败仍被看见」的唯一去处 —— 没有它，降噪就变成
狼来了的反面。

## 六、迁移里带数据写入：本仓库第一次

`drizzle/{sqlite,postgres}/0010_add_source_consecutive_failures.sql` 加列之后紧跟一条
`UPDATE "sources" SET "consecutive_failures" = 2 WHERE "healthy" = 0;`。**先例边界要写清**：

- 为什么必须播种：不播种则一个**当下正红着**的源在下一轮失败时被算成「第 1 次」，按新门槛
  判健康 ⇒ 一个真挂着的源静默转绿且不发信。这是最坏的一种修坏。
- 播种的代价（明确接受）：部署时已红的源不会在下一轮再收到邮件，它要走到第 9 轮才重发；
  看板照常红着，且操作者前一天刚收过它的信。
- 为什么这仍然是"最后一次"在迁移里写数据：`0011_drop_source_schedule_config.sql` 只删列。
  业务数据的修补应该走一次性 SQL + 回查（见 `deploy/`），不该沉到迁移里。
- 手写迁移的两方言一致性由 `migrations-integrity.test.mjs` 守（序号序列 + 列集合）。该测试
  比对列集合的正则只认列定义行，`ALTER TABLE … ADD …` 两边都匹配不到，走 `size === 0` 分支。

`0011` 删列的前置条件是**全表该列都等于 `'{}'`**（回查见 `deploy/audit-sources-flaky.sql`）。

## 七、摘要显示态：五分支一个函数

新纯函数 `src/lib/summary-display.ts` 的 `summaryDisplayState()` → `view | unavailable |
review | not-generated | generating`。优先级是有意的，出错方式只会是顺序不对：

1. `hasSummary` **永远第一** —— 已截止但已有 done 摘要的条目照常渲染，本次修改绝不能误伤它；
2. `!llmReady` → 「暂未启用」（#22 的门控语义不变）；
3. `failed_review` → 待人工复核（与截止无关，队列里的事）；
4. `pending` + 已截止 → **新**「未生成摘要」（无进行时）；
5. 其余 → 「生成中」。

判据用**库列** `notices.status`，不用页面上的 `effectiveStatus`：摘要入队过滤用的就是前者，
跟着它才不会自相矛盾。代价是「库里还写着 open、今天刚过期」的条目会让「生成中」多挂一天
（诚实的上界：它确实还在队列里）；反过来用 `effectiveStatus` 则会把一条仍会生成摘要的条目
说成「未生成」—— 那是真话变假话。

`SUMMARY_NOT_SUMMARIZED_STATUS` 由 `src/db/repo/summaries.ts` 的 `ne()` **直接 import**：
队列与文案门同源。两处各写一份的后果就是这次的起因。

新块 `SummaryNotGenerated`（`data-testid="summary-not-generated"`）说明本站摘要只覆盖公示期内
条目，并把读者指向同一页上由程序逐字摘录、不依赖大模型的结构化速读与提交方式。
`SUMMARY_STATUS_LABELS` 保留，但降级为「`summary_status` 的中文名」，不再是页面的真相来源。

## 八、死源与文档口径

`govcn` 行按「生产删行 + 改文档」处理：删除 SQL 把「0 条目」写进 `WHERE` 当保险
（`deploy/cleanup-govcn-source.sql`），删不掉就说明情况变了，宁可停下也不盲删。
`docs/prd/v1.md` 的该栏目标注已下线、由 `mee` 替代。

## 九、验收回查表（生产，需在授权后）

| 回查 | 期望 |
| --- | --- |
| `select id, healthy, enabled, consecutive_failures, last_error_at from sources order by id;` | 迁移后 `healthy=0` 的行 `consecutive_failures=2`；`govcn` 不在结果里 |
| `select count(*) from notices where source_id='govcn';` | 0（DELETE 的前置） |
| `select id from sources where schedule_config_json <> '{}';` | 0 行（DROP COLUMN 的前置） |
| npc 若仍超时：下一轮 | `consecutive_failures=1`、仍 `healthy=1`、**无新告警邮件** |
| npc 连续两轮失败 | 转红且恰好一封 |
| 已截止条目详情页 | 显示「未生成摘要」，页面不含「摘要生成中」 |
| 已截止但已有摘要的条目 | 摘要照常渲染 |
| `/_next` 与全站响应头 | 不变（本轮刻意不动 CSP，理由见 `next.config.ts:14-16` 与 FOLLOWUPS 的 #52 行） |

## 十、未做（有意）

- 每跳独立预算合并成单请求总预算（见第二节第 2 条）。
- 按源超时的 DB 化（明确否掉，见第三节）。
- 存量已截止条目的摘要不重刷：它们的「未生成」是真话，不是待修的状态。
- `ATTACHMENT_TEXT` 保持 `shadow`：本轮不翻 `on`，不与信号改动混在同一次上线里判断。
