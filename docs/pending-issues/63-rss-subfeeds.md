# issue #63：RSS 只有「全站」一副（迭代 5 第 2 刀：按条件订阅的子 feed）

对应提交：（第 2 刀）

## 一、这一刀解决什么

`/feed.xml` 从 issue #6 起只有一份：全库最新 200 条。这带来两个具体问题：

1. **触达只有一条腿**。邮件提醒走的是个人 QQ 邮箱授权码（已知短板：发信量与到达率都受限制，
   见 `project-smtp-qq-choice`），RSS 是**不依赖发信**的第二条通道 —— 但它只能订"全部"。
   一个只关心生态环境的人，要么订全量被其他领域刷屏，要么自己每周手动来看。
2. 第 1 刀（#62）刚把筛选做完：页面上能筛出「只看未截止的生态环境」，**但这个条件带不走**。
   筛完想长期跟，只能把地址收藏成一个网页 —— 那不是订阅。

这一刀把筛选条件变成可长期订阅的地址：`/feed.xml?category=生态环境&open=1`。

## 二、做了什么

- `GET /feed.xml` 接受与首页**同一套**筛选参数：`category` / `agency` / `lead` / `q` /
  `month` / `from` / `to` / `period` / `open` / `since`。参数解析直接复用 `parseHomeQuery`，
  WHERE 直接复用 `filterConditions` —— 条件口径不另写一份。
- 频道标题与描述说明这份 feed 装的是什么：
  标题 `主人翁 —— 政府公示信息聚合 —— 生态环境 · 只看未截止`，
  描述里写明「本频道是按条件订阅的子 feed（条件：…）；全量订阅见 /feed.xml」。
- `atom:link rel="self"` 带上条件（阅读器据此区分两份订阅，不会把它们并成一个源）。
- 首页在**有筛选时**多一个入口：「只订这一批（RSS）」，地址由 `subFeedHref` 生成。
- XML 转义沿用 `escapeXml`：条件文本是用户可控输入，会出现在 `<title>` 与属性值里。
- 顺带合并掉 `listNoticesByPublishedDesc`：它的 ORDER BY 与 `ORDERS.published` 一字不差，
  feed 改走 `listNoticesFiltered({ sort: 'published' })`（同一份排序实现，见 #62）。

## 三、几个决定的理由

**feed 不吃 `sort` 与 `page`**。RSS 阅读器按 `pubDate` 自己排序，feed 也没有分页概念。
把它们收进参数清单里、然后什么都不做，就是本项目反复清掉的那类**假旋钮**
（#58/#59 的教训：一个不生效的旋钮比没有旋钮更糟，因为它承诺了一件事）。
路由因此显式列出它读的键（`feedSearchParams`），feed 顺序固定为发布日期倒序。

**未知值不生效时，频道标题也不加条件**。`?category=不存在的领域` 渲染的是全量内容；
若标题仍写「按不存在的领域订阅」，标题就在对读者撒谎。判据用 `hasFilter`，
与首页那行「筛选后共 N 条（…）」同一个开关。

**条件的"说法"与"地址"收成一份**。首页摘要行的文案（原 `monthFilterSummary` + 内联数组）
移到 `home-query.ts` 的 `describeHomeQuery`，子 feed 地址是 `subFeedHref`。
理由是这个项目写过很多遍的那句话：同一个口径两份实现，迟早给出相反答案 ——
而这里两处的"答案"必须逐字相同（读者对照页面与阅读器里的频道名时，看到的是同一句话）。

**`?month=` 别名在地址里折平成 `from` / `to`**（解析层已经折平，序列化时直接用折平结果）：
同一条件只有一个规范地址，否则两份订阅会因写法不同被阅读器当成两个源。

## 四、这一刀的自证边界（明写）

`check-test-pins.mjs` 的规则 1：页面与路由跑的是 `.next` 构建产物，撤源码不会让 e2e 变红。
因此**「路由把哪些参数转给仓储」这一段无法用 pins 自证**（`feedSearchParams` 里漏掉
`open` 这一行，撤源码 e2e 才红，pins 跑不到）。它的保障换成了另一条更值钱的断言：
**同一条件下，首页渲染出的条目集合 = feed 里的条目集合**（`feed-filters.test.mjs` 里出现 4 次，
覆盖单条件、状态口径、时间窗口、条件叠加）。这条断言同时兜住了"两处口径分家"的整个类别，
而不只是这一个参数。

能自证的部分都进了 pins：频道标题带条件、self 带条件、`describeHomeQuery` 的维度、
`subFeedHref` 丢掉某个维度（各钉 open 与 since 一次）。

## 五、测试与自证

- `tests/e2e/feed-filters.test.mjs`（15 例）：全量 feed 行为一字不改（标题、描述、self、顺序）；
  子 feed 与首页同集合；条件写进标题与描述；转义；0 条也生成合法 feed；
  `sort` / `page` 不掺和；首页入口的出现与消失（无筛选、只有 sort 时都不出现）。
- `tests/unit/feed-subscription.test.mjs`（7 例）+ `tests/unit/home-query.test.mjs`（+5 例）。
- `scripts/check-test-pins.mjs`：64 → 69 条，全红。
  其中「频道标题不写条件」这条**首版是假绿**：撤掉 `feedChannelTitle(filterLabel)` 后测试仍过，
  因为我把名字模式指向了 `describe('频道标题与描述')` —— 那一组直接测函数本身，
  而**经过 `buildFeedXml` 拼出 XML** 的断言在另一组里。修法不是改措辞，是补一条真正
  从 `buildFeedXml` 输出里读 `<title>` 的断言，再把名字模式指过去。
  （脚本头注的规则 2 讲的是同一件事的另一面：名字模式要选中**会产生被断言状态**的那些用例。）

## 六、发现层还剩什么

清单收在 `62-discovery-sorting.md` 第六节（同一份待办写三处必然会烂在一处，
这是本项目一直在躲的那类问题）。本文只补一句：子 feed 的参数面与首页同口径，
所以那一份清单里任何新加的筛选维度，都应当自动对 feed 生效 —— 依据是
`feedSearchParams` 与 `parseHomeQuery` 共用解析、`filterConditions` 共用 WHERE。
