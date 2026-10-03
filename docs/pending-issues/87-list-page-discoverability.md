# 87 列表页可发现性：让读者在列表页看出「这条有没有 AI 判读 / 改动对照」

> 只读研究产出的**设计文档**，不含实现。所有事实分两类标注：**【读代码】**= 从仓库源码读出来的；
> **【量过】**= 真的跑了只读查询量出来的（并写明量的是哪个库）；**【没量到】**= 明确没量、不编数。

## 0. 这一刀要解决的问题

用户的原话：最终目标是让读者找到对自己和社会有影响的条例（吸毒修正案、留学生 Z 签都是事后
曝光才有人参与）。今天读者**必须先点进详情页**才知道这条公示有没有「可能的争议点」——
而那是全站唯一一段回答「这事跟我有没有关系」的内容。

背景事实（用户今天在生产量到，本设计**直接采用，未复核**）：全库 201 条公示；期内 62 条全部有
摘要；期中「公众广域 + 期内」3 条全部有判读；全库 92 条摘要里只有 8 条带判读、只有 1 条带
「改了哪几处」完整表。

**这一刀的产出不是新内容，而是把已有的 8 条从「详情页里埋着」变成「列表页一眼看得见」。**
它不增加任何一次模型调用，唯一的新东西是一行字。

## 1. 现状测绘

### 1.1 列表只有两处，且共用同一个组件

| 路由 | 查询函数 | 分页 | 索引口径 |
| --- | --- | --- | --- |
| `/`（首页，**兼唯一的分类页**） | `listNoticesFiltered` + `countNoticesFiltered` | `LIST_PAGE_SIZE`（默认 50） | 无筛选可收录；**带任何筛选即 noindex** |
| `/search?q=` | `createSearchPort().search()` 取 id → `getNoticesByIds` | `SEARCH_PAGE_SIZE`（默认 50） | 整页 noindex、follow |

- **没有独立的分类页路由**：`src/app/` 下只有 `page.tsx`（首页）、`search/`、`stats/`、`notices/[id]/`、
  `admin/`、`subscribe/`、`unsubscribe/`、`feed.xml/`、`go/`。领域 / 受众面 / 机关 / 来源 / 月份 /
  公示期 / 排序 / 未截止 / 最近新增**全部是首页的 querystring**（`?category=`、`?audience=` …）。
  【读代码】
- 两处都渲染 `src/app/_lib/notice-item.tsx` 的 `<NoticeItem>`——全仓只有这两个调用点，所以
  **改这一个组件 = 同时覆盖首页、搜索、以及首页上的全部筛选视图（含"分类页"）**。【读代码】

### 1.2 列表项现在渲染哪些字段

`NoticeItem` 只读 `NoticeRecord` 的这几项：【读代码】

| 位置 | 字段 | 说明 |
| --- | --- | --- |
| 头部 | `effectiveStatus(notice, now)` | 状态徽标（展示口径，非库列） |
| 头部 | `countdownText` | 倒计时（仅"征求意见中"+ 有截止日） |
| 头部 | `isNewNotice(firstSeenAt, now)` | 「新」角标（固定 7 天窗口） |
| 主体 | `title` | 指向 `/notices/<id>` 的链接 |
| 元信息 | `agency` / `publishedAt` / `deadlineAt` | 一行文字 |
| 底部 | `categoryTags` | 领域标签小片 |

**列表项刻意没有的东西**：受众面角标、体裁角标、摘要存在与否、判读存在与否。前两者只出现在
详情页（`src/app/notices/[id]/page.tsx` 的 `.detail-badges`），后两者全站**任何地方都没有**
「这条有没有」的可见信号（真相只存在于详情页那一块渲不渲染）。【读代码】

### 1.3 `notices` 表里与「有没有判读」有关的列

摘要是**单列 JSON**：`notices.ai_summary_json`（TEXT，可空），形状是 `QuotedSummary`
（`src/lib/summary-content.ts`）。**没有任何一列是"判读条数"或"改动条数"**。【读代码】

| 相关列 | 与判读的关系 |
| --- | --- |
| `ai_summary_json` | 唯一真相：`impacts[]`（判读）、`changes[]` + `changeTable`（改动对照）都在里面 |
| `summary_status` | `pending` / `done` / `failed_review`——**说不了"有没有判读"**（同一 `done` 下有判读和无判读并存） |
| `summary_model` | 溯源用，与"有没有判读"无关 |
| `summary_diagnostics_json` | 只给审计脚本与后台看，**页面不读**（且人工录入的摘要是 NULL） |
| `audience` | **门控的另一半**：判读只对 `public` 渲染 |

形状细节（决定判据怎么写）：`impacts` / `changes` / `changeTable` 都是**后加的键**，
`parseQuotedSummary` 对缺失键一律宽容（旧行 ⇒ 空数组 / null，不算形状异常）；
`changeTable` 是 worker 在 `changes` 定下之后**补写**的，所以历史行可能是 `changes` 非空而
`changeTable` 为 null。【读代码】

### 1.4 列表查询其实已经把摘要 JSON 读进内存了（这一点决定成本对比的结论）

`listNoticesFiltered` 用的是 `db.select().from(notices)`——**全列**；`toNoticeRecord` 末尾就是
`aiSummary: safeParseJson(row.aiSummaryJson)`。【读代码】

也就是说：**列表页今天已经在为"判读"付出 JSON 解析的代价，只是把结果丢了**（`NoticeItem`
没读 `notice.aiSummary`）。搜索页走 `getNoticesByIds`，同样是 `select()` 全列 + `toNoticeRecord`，
一样已经解析过。【读代码】

`NoticeRecord` 上**没有** `summaryStatus` 字段（只有 `aiSummary`）；`SummaryView` 自己是拿
`summaryJson` 字符串再 `parseQuotedSummary` 一遍的，与 `notice.aiSummary` 不是同一次解析。
【读代码】

【没量到】列表页的真实渲染耗时、单条摘要 JSON 的平均大小。本地 dev 库 `data/zhurenweng.db`
是空的（`notices` 0 行、连 `0016` 的 `audience` 列都还没有），所以**这一刀的行数与体积我一条都没量到**，
上面关于成本的判断全部是"读代码 + 结构性推理"，不是实测。

## 2. 成本对比：三种做法的取舍

### 2.1 判据到底是什么（先把口径钉死，否则三种做法无法比较）

详情页今天渲不渲染那两块，判据是两处代码：【读代码】

- 判读：`shouldRenderImpacts({ audience, impacts })`——`audience === 'public' && impacts.length > 0`；
- 改动对照：`changes.length > 0 || table !== null`（其中 `changes` / `table` 来自
  `parseQuotedSummary`；页面再经 `changeTableRows(changes, table)` 决定实际行）。

两个判据的输入都**只在 `ai_summary_json` 里**（加上 `audience` 列）。

### 2.2 三种做法

| 做法 | 读路径代价 | 写路径代价 | 迁移代价 | 主要风险 |
| --- | --- | --- | --- | --- |
| (i) 列表查询照旧，渲染时解析 ≤50 行 JSON | 每次列表多 ≤50 次 `JSON.parse` + 一次纯函数解析（**JSON.parse 今天已经付过了**） | 0 | 0 | 解析放在渲染路径上；页面上两处判据若各写一份会漂移（有解，见第 3 节） |
| (ii) 加物化计数列，查询时用在 SQL 侧 | 查询少解析几个 JSON（省的是今天已在付的那点开销） | 0 | 手写双方言迁移 + 两个 journal 的 `when` 单调递增 + 存量回填脚本 | **多一个需要维护的真相**：判读定义一变，列与 JSON 分叉 |
| (iii) 摘要落库时同一次写入把计数写进新列 | 同 (ii) | 写侧多几个参数（只有一个写入点，见下） | 同 (ii) | 同 (ii)，**外加**"写入点"其实不止一个 |

关于 (iii) 的"只有一个写入点"：`saveNoticeSummary` 确实只有一个实现
（`src/db/repo/summaries.ts`），但它的**调用方有两个**——worker 的
`worker/jobs/summarize-notices.ts`（自动生成）与 `src/app/admin/review/route.ts`（人工复核手工录入）。
后者是手写摘要，一样要维护这个列，否则人工录入的条目会带着"没有判读"的假标记。【读代码】

### 2.3 推荐：(i)，并且理由不是"省事"

1. **收益差≈0，代价差很大**：列表查询今天已经把 `ai_summary_json` 取回并 `JSON.parse` 过了
   （1.4 节），(i) 的增量只是对 ≤50 个已解析对象跑一次纯函数解析。而 (ii)(iii) 要付
   迁移 + 回填 + 第二个写入点 + 一个新的、会漂移的真相。
2. **(ii)(iii) 治的是不存在的病。** 物化列的价值在"要用 SQL 按它筛选/排序/聚合"。本设计
   推荐的这一刀**不加筛选**（见第 6 节待拍板第 4 条），只是渲染一行字——没有一处 SQL 用到它。
   花一次迁移买一个没人查的列，是纯负债。
3. **(ii)(iii) 引入的漂移会表现为"页面自相矛盾"**，而这个仓最贵的缺陷就是这一类。
   判读的定义这两周改过至少四次（#76 建立 → #85 整体删除 → #86 重建 → 2026-09-28 的"复述条文
   不是影响"改口）。每次改口，(ii)(iii) 都要一次数据迁移 + 一次全量回填；漏一次，
   列表页说"含判读"而详情页一个字都没有——**正是第 3 节要消灭的那件事**。
4. **存量 92 条按 (i) 立刻正确**（真相就在 JSON 里），按 (ii)(iii) 则要等一次回填跑完。
   而回填脚本要 import 的判据，正是 (i) 要抽出来的那个纯函数——(ii)(iii) 并不省掉这一份判据，
   只是把它挪到写侧。
5. 将来若要加筛选（`?has=impacts`），(ii) 才第一次有真价值；那时再按当时的定义加列，
   比现在加一个会过期的列便宜。（把这一条登记为挂账，见第 6 节。）

**代价与风险（诚实地说 (i) 的坏处）**：

- 列表页的每一次渲染都多一次解析；50 行 × 数 KB 的 JSON 是毫秒级，但我**没量到**（本地库是空的）。
  若将来 `LIST_PAGE_SIZE` 被调到几百、或单条摘要涨到几十 KB，这里是第一个该回头看的地方。
- 判据放在渲染路径上，就**必须**有第 3 节那道门与单测，否则它是"页面上看着对、撤掉没人发现"的一类。
- `NoticeItem` 变成读摘要的组件之后，它会**更依赖 `aiSummary` 这一列**；`toNoticeRecordWithoutContent`
  那条入口（邮件路径）给的是 `aiSummary: null`，标记自然为"无"——这是对的，但要在单测里写下来。

## 3. 硬约束：列表页的标记必须与详情页同一道门

### 3.1 约束（写成设计里的显式约束，不是建议）

> **任何"这条有判读"的可见信号，其判据必须与详情页渲染那一段的判据同源。**
> 具体：判读标记一律经由 `shouldRenderImpacts`（`src/lib/impact-display.ts`）判定，
> **不许**在页面或新模块里重写 `audience === 'public' && impacts.length > 0` 这个表达式。
> 违反的后果是具体的、不是理论的：库里 30 条左右的 `sector` 条目**存着判读但一个字都不显示**
> （门控；用户 2026-09-27 拍板"先只上公众广域 + 人工过一遍"），列表页若照库里的数组打标记，
> 读者点进去会发现**什么都没有**——列表页在承诺详情页不存在的东西。

同一句话的另外两面：

- **未判定（`null` / `unknown`）不许打标**：`shouldRenderImpacts` 已经这么判，标记跟它走即可
  （"判不出来就不给它加码"）。
- **标记只能说"有"，不能说"无"**：`sector` 条目、未截止但还没生成摘要的条目、`failed_review` 的条目
  一律**不打任何标记**。写一个灰色的「暂无判读」会变成一句关于内容质量的评语，而且它会把
  门控暴露成"这条被判成行业专业了"——那是内部口径，不是读者要的信息。

### 3.2 判据落在哪个 `.ts`

新建 **`src/lib/notice-marks.ts`**（纯函数，无 IO、无 React）。理由与本仓既有规矩一字不差
（`summary-display.ts` / `impact-display.ts` / `change-table.ts` 的文件头都写了同一条）：
**页面 `.tsx` 里的分支进不了自证框架**——`scripts/check-test-pins.mjs` 的硬规则第 1 条写着
"被撤的实现必须从源码被执行；e2e 里 `startAppServer` 跑的是 `.next` 构建产物，
改 `src/app/**` 与 SSR 侧 lib 对它无效（撤了也不红 = 假绿）"。所以：

- **判据**（"这条有没有判读 / 有没有改动对照"、以及"该说什么"）→ `src/lib/notice-marks.ts`，用
  `node --test` 直读的单测钉住，并能进 pin 表；
- **怎么画**（`<span class="notice-mark">`、放哪一行、`data-testid` 叫什么）→ `src/app/_lib/notice-item.tsx`，
  e2e 只钉"接线对不对"（用注入一行摘要的老办法），不指望它钉判据。

形状建议（把"判据"与"文案"分开，这样改文案不会动判据）：

```
// 返回"识别出的标记种类"，而不是字符串
export type NoticeMarkKind = 'impacts' | 'changes';
export function noticeMarks(input: { audience: NoticeAudience | null; summary: QuotedSummary | null }): NoticeMarkKind[]
// 文案与无障碍说明（改措辞只动这张表）
export const NOTICE_MARK_LABELS: Record<NoticeMarkKind, string>
export const NOTICE_MARK_HINTS: Record<NoticeMarkKind, string>
```

`noticeMarks` 内部必须**调用** `shouldRenderImpacts`（把 `summary.impacts` 传进去），而不是抄它的
表达式；`changes` 那一支与详情页保持同一判据 `summary.changes.length > 0 || summary.changeTable !== null`。
解析只有一处：入参收 `QuotedSummary | null`，由调用方（`NoticeItem`）用
`parseQuotedSummary(notice.aiSummary)` 解析一次并复用；**不要**为了门控在内部再解析一遍。

## 4. 措辞：不许过度声明（这是本站最敏感的地方）

### 4.1 约束

判读是**推断**，不是官方表述，也不构成法律意见。这句话今天写在两处：卡片头部的
`AI_DISCLAIMER_TEXT`（`'AI 生成，仅供参考，以官方原文为准'`）与**判读那一段自己的块级免责声明**
（`summary-impacts-note`：「以下是本站 AI 依据公开原文作出的**推断**，不是官方表述，也不构成法律意见；
每条都附了它依据的那句原文，请自己判断。」）。【读代码】

列表标记**不能**把这句话完整搬过来（它是一行角标，不是段落），但也**不能**用一个读起来像结论的词。
判据：一个只读列表页、不点进去的人，读到这行字之后**不该**产生"官方认定了这里有争议"的印象。

### 4.2 推荐措辞

| 标记 | 推荐文案 | 理由 |
| --- | --- | --- |
| 有判读 | **含本站推断（非官方）** | 主词是「推断」（与段内免责声明同一个词），「本站」把归属说清，「非官方」是这句话里最要紧的三个字 |
| 有改动对照 | **含改动对照** | 它是**事实**（每行都挂着逐字原文与可核对说明），不需要"推断"这层限定；「对照」与详情页的标题「改了哪几处」不冲突（对照表正是那个意思） |

**为什么不推荐「含 AI 判读（推断）」**（候选里最像的那个）：它有两个毛病。
① 对读者来说「AI」不是一个可核对的声明，本站今天把「AI 生成」标注收在**卡片头部**
（合规要求：AI 摘要必须显著标注），列表项没有、也不该有卡片头；把「AI」撒到每一个列表项上，
等于用一个读者读不出信息量的词占掉了那行字最贵的位置，而**归属**（本站）与非官方性反而丢了。
② 「判读」是内部词（源码里的注释用「影响判读」），读者看到的是详情页的标题「可能的争议点」；
列表页用一个详情页上不存在的词，点进去会找不到对应物。

**为什么不推荐「含可能的争议点」**：它把详情页那个谨慎的标题（「可能」二字撑着）剥成了断言。
列表页没有上下文解释"可能"是谁说的，读起来最接近"这条有争议"。

### 4.3 与详情页那段块级免责声明的关系

- **列表标记是提示词，不是免责声明**：它只说"点进去有一段本站的推断"，**不重复**免责声明的义务；
  义务仍由详情页那段块级声明履行（它在，且不许因为列表页有了标记就删）。
- **措辞必须能对上**：标记用「推断」二字，详情页那段用「推断，不是官方表述」——读者点进去
  看到的第一个词与列表上看到的是同一个，这行标记才不是一次 bait。
- **完整说明挂 `title`**：标记的 `title` 写 `'本站 AI 依据公开原文作出的推断，不是官方表述，也不构成法律意见'`
  （与段内声明同义），悬停与读屏都拿得到，而列表不因此变长。
- **不写进 JSON-LD**：详情页 `buildNoticeJsonLd` 是 `Article`，列表页是 `ItemList`，两边都没有
  "本站有一段推断"这种语义的准确属性，硬造一个属性就是让机器读到我们编的东西（见第 5 节）。

## 5. 要动的东西清单

### 5.1 新增

| 文件 | 内容 |
| --- | --- |
| `src/lib/notice-marks.ts` | `noticeMarks()` + `NOTICE_MARK_LABELS` + `NOTICE_MARK_HINTS`（第 3.2 节的形状；`impacts` 一支**调用** `shouldRenderImpacts`） |
| `tests/unit/notice-marks.test.mjs` | 见 5.4 |
| `drizzle/**` | **不动**（本设计不加列） |

### 5.2 修改

| 文件 | 改什么 | 为什么 |
| --- | --- | --- |
| `src/app/_lib/notice-item.tsx` | `parseQuotedSummary(notice.aiSummary)` 一次 → `noticeMarks` → 渲染标记（`data-testid="notice-mark"`、`data-mark="impacts\|changes"`） | 唯一的渲染点，首页 + 搜索 + 全部筛选视图一起生效 |
| `src/app/globals.css` | 新增 `.notice-mark`（一条或两条规则） | 现成的 `.genre-badge` / `.notice-new-badge` 附近就有可复制的样式语言；**视觉层级必须低于状态徽标**（它是"这条里有什么"，不是"该不该行动"） |

### 5.3 明确**不**动的地方

| 文件 / 面 | 为什么不动 |
| --- | --- |
| `src/db/repo/notices.ts`（`listNoticesFiltered` / 排序 / `stillOpen`） | 这一刀不加筛选、不改排序，SQL 一个字不改（第 2.3 节） |
| `src/db/schema/{sqlite,postgres}.ts` + `drizzle/**` + 两个 `_journal.json` | 不加列（若用户拍板要筛选，见第 6 节第 4 条，那时才需要手写迁移 + `when` 单调递增） |
| `src/app/page.tsx` / `src/app/search/page.tsx` | 不传新 prop、不改 metadata。**索引口径不变**：带筛选本来就 noindex，标记不改变"这一页该不该收录" |
| `src/app/_lib/summary-view.tsx` | 详情页那段一个字不改（判据已经抽在 `.ts` 里）。**禁止**为了"对上"而改详情页文案 |
| `src/lib/notice-jsonld.ts` | 结构化数据不加"含判读"。`ItemList` 今天只输出 `position` / `url` / `name`；往里加一个 AI 推断信号是给搜索引擎一句我们无法核对的话 |
| `src/lib/feed.ts` / `sitemap.ts` / `robots.ts` | RSS 条目描述、sitemap 与可发现性都不该承载这个标记（feed 的 `summarySnippet` 只取摘要正文，不许变成"含推断"的广播） |
| `src/app/_lib/home-query.ts` | 这一刀不加 querystring 维度 |

### 5.4 需要的单测与 pin

**单测** `tests/unit/notice-marks.test.mjs`（`node --test` 直读 `.ts`，与
`tests/unit/summary-impacts.test.mjs` 的「给谁看」那一组同构）：

1. `audience: 'public'` + 有 `impacts` ⇒ 含 `'impacts'`；
2. `audience: 'sector'` / `'unknown'` / `null` + **同样有** `impacts` ⇒ **不含** `'impacts'`
   （**这一条就是第 3 节的约束本尊**——库里真有一批这样的条目）；
3. `impacts` 为空数组 ⇒ 不含 `'impacts'`（空壳比没有更坏，与详情页同一条）；
4. `changes` 非空而 `changeTable` 为 null（历史行）⇒ 含 `'changes'`；`changeTable` 非空而
   `changes` 为空 ⇒ 也含 `'changes'`（与详情页 `changes.length === 0 && table === null` 那个
   提前返回**逐字对齐**）；
5. `summary` 为 `null`（无摘要 / 旧形状解析失败）⇒ 空数组；
6. **契约测试**：同一份输入分别喂 `noticeMarks` 与 `shouldRenderImpacts`，两者的 `impacts` 结论
   必须一致（对象不同、字面相同也算）——把"同一道门"钉成可执行的东西，而不是注释里的一句话；
7. `NOTICE_MARK_LABELS.impacts` 含「推断」且含「非官方」（措辞不许被悄悄改软——与
   `summary-impacts.test.mjs` 里那一组"提示词实质要求"同一个路数）。

**pin**（加进 `scripts/check-test-pins.mjs` 的 `TARGETS` 与 `CASES`；`from` 必须是目标 `.ts` 里
**唯一的一行**、撤掉它对应用例必须**真变红**）：

| 靶点 | `from`（示意，实现时按真实行号抄） | 撤成 | pattern（选中的用例名） |
| --- | --- | --- | --- |
| 列表标记不再看受众面 | `  if (shouldRenderImpacts({ audience, impacts })) {` | `  if (impacts.length > 0) {` | 行业专业条目：列表不打判读标记 |
| 旧行（无 `changeTable`）也被要求有表才算改动对照 | `  const hasChanges = changes.length > 0 \|\| table !== null;` | `  const hasChanges = changes.length > 0 && table !== null;` | 改动对照：只有说明行也算 |

`TARGETS` 补 `noticeMarks: 'src/lib/notice-marks.ts'`。两条都指 `tests/unit/notice-marks.test.mjs`
（**不能**指 e2e：`src/lib/**` 是 SSR 侧源码，e2e 跑 `.next` 构建产物，撤了不红 = 假绿灯，
见 `check-test-pins.mjs` 文件头第 1 条）。

**e2e（接线，可选但推荐）**：仿 `tests/e2e/notice-audience.test.mjs` 的注入法——
直接往 e2e 的 SQLite 里 `update notices set audience='public', ai_summary_json=?`，再抓首页
断言 `data-testid="notice-mark"` 出现 / 不出现。它钉的是"组件真的把它画出来了"，
钉不住判据（撤 `src/app/**` 撤不出红）。**本设计不把它算作判据。**

### 5.5 样式 / 可访问性 / 结构化数据

- **样式**：`.notice-mark` 用描边而非填色（和 `.notice-new-badge` 同一档），字号 12px，
  不许用红色系——红在这套样式里已经是"已截止"（`.status-closed`）与"今天截止"（`.countdown-urgent`）。
- **可访问性**：标记是**文本**（不是纯图标），`title` 给完整说明；`<ul>` 里没有额外交互，
  不引入 tabindex。若实现时发现标记与标题链接被读屏并成一句，给标记加 `aria-label`。
- **结构化数据 / SEO**：**无影响**（第 5.3 节）。要注意的是反向的一条硬约束：
  **不许把判读正文渲染进列表页**——那会把 AI 推断变成可索引的页面内容，也会把"点进去看"
  这个动作取消掉。列表只出"有"这个信号，正文永远只在详情页。

## 6. 需要用户拍板的问题（不替他决定）

1. **标记放在哪些列表？** ① 首页 + 搜索（改 `NoticeItem` 一处即全中）；
   ② 只首页（搜索页要另做一套条件渲染）。
   影响：搜索页是"带着目的来找"的人，标记对他也最有价值；但搜索结果页是 noindex 的，
   标记在那一页不会被搜索引擎读到（这可能正是想要的，也可能不是）。
2. **"只有改动表、没有判读"的条目怎么显示？** 生产上这种条目**只有 1 条**（用户提供的事实）。
   ① 同款角标、换措辞「含改动对照」；② 只在这一条上不打标（省一个字，但读者会漏掉唯一一条）；
   ③ 打标但把两者合成一个「含 AI 分析」——**不推荐**，它把"事实"与"推断"混成一句，
   正是第 4 节要避免的过度声明。
3. **已截止条目要不要也显示标记？** 判读不设"期内"门控（它挂在摘要里，摘要只对期内条目生成），
   所以已截止条目**可能有判读**。① 有就显示（信息仍有效，且是"事后曝光才有人参与"那类案子的存档）；
   ② 只在未截止条目上显示（把注意力留给还能行动的）。
   **注意**：这一条与第 3 节的受众面门控**无关**（门控是门控，时效是时效），别混成一道门。
4. **这一轮要不要加 `?has=impacts` 筛选入口？** 若加，(i) 的结论要重算：筛选用 SQL 表达才划算，
   那就需要做法 (ii) 的物化列（手写双方言迁移 + 回填）。**本设计建议不加**——
   先让 8 条被看见，等真的有人要找"全部有判读的条目"时再付这笔迁移。
5. **要不要给「有摘要但没有判读」的条目一个弱标记（如「AI 摘要」）？** 本设计建议**不要**：
   全库 92 条有摘要，这个标记会出现在近一半的条目上，于是它不传递任何区分度——
   而 8 条判读正是被这个噪声淹掉的那部分。若用户要，另开一刀讨论。
6. **验收方式**：列表标记在生产上怎么确认？本地 dev 库是空的（1.4 节【没量到】），
   e2e 只能靠注入 fixture 行。可选项：① 只靠 e2e 注入 + 单测；② 上线后由用户在生产上
   目视列表页（今天的 3 条公众广域期内条目应当带标记）；③ 先做一个只读审计脚本打印
   "应当带标记的条目 id 清单"（不新增页面、不连生产，由用户在能连库的机器上跑）。
   本设计倾向 ① + ②，③ 留给"标记数量对不上"时的排查。

## 7. 一句话结论

**判据抽进 `src/lib/notice-marks.ts` 并调用 `shouldRenderImpacts`；渲染只改 `NoticeItem` 一处；
不加列、不加迁移、不加筛选、不写进结构化数据。** 这一刀的产出是让库里那 8 条（今天只有
1 条带改动表）从详情页里走出来，代价是一次 ≤50 行的纯函数解析。

## 8. 落地记录（2026-10-03 当日完成）

> 上线后再回来看这一节：数量要按当天的库现状读（本文件写于 09-27，那天的"8 条判读"
> 到 2026-10-03 已是 **11 条**，全库摘要 97 条）。

### 8.1 第 6 节那六个问题的拍板

| # | 问题 | 用户拍板 |
| --- | --- | --- |
| 1 | 标记放在哪些列表 | **只首页**（搜索页**显式**关掉，见 8.2） |
| 2 | 只有改动表、没有判读的条目 | **换措辞打标**「含改动对照」（不打就永远没人看得到那唯一一条） |
| 3 | 已截止条目要不要显示 | **有就显示**（时效不设门控 —— 与受众面门控是两回事，不混成一道门） |
| 4 | 加不加 `?has=impacts` 筛选 | **不加**（按本文建议，先让那几条被看见） |
| 5 | 「有摘要没判读」的弱标记 | **不加**（会在近一半条目上出现，反而把判读淹掉） |
| 6 | 验收方式 | **① e2e 注入 + 单测** 与 **② 上线后人工过一眼首页** |

### 8.2 落地形状

| 文件 | 内容 |
| --- | --- |
| `src/lib/notice-marks.ts`（新增） | `noticeMarks()` / `NOTICE_MARK_LABELS` / `NOTICE_MARK_HINTS`；`impacts` 那一支**调用** `shouldRenderImpacts`（不抄表达式），`changes` 那一支与详情页提前返回逐字对齐 |
| `src/app/_lib/notice-item.tsx` | 新增 `showMarks` 参数（**默认 true**）+ `parseQuotedSummary` 只解析一次 + 渲染 `data-testid="notice-mark"` / `data-mark=…` / `title=…` |
| `src/app/search/page.tsx` | 显式传 `showMarks={false}`（用户拍板"只首页"；例外写在例外发生的地方，而默认值留给列表页的应有之义） |
| `src/app/globals.css` | 新增 `.notice-mark`（描边 + muted，比状态徽标弱一档、不用红）；`.notice-item-head` 加 `flex-wrap: wrap`（多一个标记后在 332px 窄栏里不换行会溢出） |

**没有动**的：`drizzle/**`（不加列）、`notices.ts`（SQL 一个字没改）、`summary-view.tsx`（详情页
一个字没改）、`notice-jsonld.ts` / `feed.ts` / `sitemap.ts`（结构化数据与广播不承载这个信号）、
`home-query.ts`（不加 querystring 维度）—— 与第 5.3 节一致。

### 8.3 两处"夹具先错、才看出判据的形状"（记下来，免得下次再踩）

1. **`parseQuotedSummary` 的必需段是 `what` / `deadline` / `howToComment`** ——
   `summary-content.ts` 里 `if (!what || !deadline || !howToComment) return null`。
   第一版 e2e 注入的摘要只给了 `impacts`，于是整份解析成 `null`、标记**静默不打**：
   表现是"判据没错、页面也对，就是没有那一行"。这与 §1.4 说的"对缺键宽容"**不矛盾**：
   宽容的是后加的键（`impacts` / `changes` / `changeTable`），不是这三段。
2. **两个标记的门控不一样**：`impacts` 跟着受众面门控走，而 `changes` **不受**它约束
   （详情页「改了哪几处」对任何受众面都渲染 —— 它是事实、不是推断）。
   第一版断言写成"sector 块一个标记都没有"，红了 —— 而它错得有价值：
   "两个标记同门控"是个很容易想当然的假设，e2e 现在把这条**不对称**钉住了。

### 8.4 门

- 单测 `tests/unit/notice-marks.test.mjs` **13 条**，其中两组是重心：
  **契约测试**（`public/sector/unknown/null` × 有/无判读 共 8 格穷举，`noticeMarks` 的
  `impacts` 结论必须与 `shouldRenderImpacts` **逐格一致**）与**源码接线** 3 条
  （组件真的调用了 `noticeMarks`、真的画了 testid/`data-mark`/`title`、搜索页真的关掉了）。
- pin **+3**：撤受众面门控 → 红；撤 `changes.length > 0 || table !== null`（收缩成 `&&`）→ 红；
  撤组件接线 → 红。
- e2e `tests/e2e/notice-audience.test.mjs` **+1 组**（注入一份已知摘要：公众广域断言两个标记
  都在且 `title` 完整，行业专业断言"判读标记不许有、改动对照照样有"）。

### 8.5 验收（第 6 问选 ①②）

上线后**人工过一眼首页**即可：带「含本站推断（非官方）」的条目点进去，应当能看到
「可能的争议点」那一段；带「含改动对照」的点进去应当有「改了哪几处」。
**若数量对不上**，再做第 6 问那个 ③（只读审计脚本打印"应当带标记的条目 id 清单"）。
