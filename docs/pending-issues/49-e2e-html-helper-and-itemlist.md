# e2e 解析器收成共享工具 + 首页 ItemList 结构化数据

## 本轮两件事（都是已记录的债/待办）

1. **清掉测试债**：本会话第四次因「单元格内容变成钻取链接」而改测试解析器
   （#45 趋势格子、#47 分布桶 + notice-brief 的副本、#48 行小计）—— 把
   「剥标签取数字」与 head 解析抽成 `tests/e2e/helpers/html.mjs`；
2. **首页 `ItemList`**（#39 起就记着的可发现性待办）：列表页此前没有任何结构化数据，
   「列表 → 条目」的机器可读声明缺一半。

## 1. e2e 共享工具 `tests/e2e/helpers/html.mjs`

导出：`stripSsrComments` / `headOf` / `cellNumber` / `robotsMeta` / `canonicalHref` /
`metaContent` / `hrefOf`。规矩写在文件头：

- **从单元格取数字前先剥标签**（`cellNumber`）—— 否则裸 `\d+` 会先命中链接 `href` 里的
  `month=2026-08` / `period=b16_30`；取不到数字时**抛错而不是返回 0**（静默的 0 会让
  「条数与表格一致」这类不变式变成假绿）；
- robots / canonical 只在 `</head>` 之前找（正文里可能出现同名文本）；
- href 单独取（React 渲染的属性顺序不固定：实测 `data-testid` 在前、`href` 在后）。

迁移了 6 个 e2e 文件（stats / notice-brief / pagination / status-freshness /
category-filter / smoke），各自的重复实现删掉、改为委托共享工具。

**过程中踩到两个自伤**（都当场被既有测试或 lint 抓住）：

- smoke 里本地 `robotsMeta(path)` 与导入同名 → 改完变成**自调用**（`fetch(html)`）；
  改名为 `robotsMetaOfHtml` 修正；
- stats 迁移后留了个未使用的导入 → lint 报错（lint 是这里的护栏）。

## 2. 首页 `ItemList`

- `buildNoticeListJsonLd({ notices, siteUrl, startPosition })`（放在既有
  `src/lib/notice-jsonld.ts`，与详情页的 Article 同一模块、同一套自律）；
- **类型选 `ItemList` 而不是 `CollectionPage`**：本页就是「一串条目」的清单，
  ItemList 正是它的机器可读形状；CollectionPage 描述的是「某个集合的落地页」，
  会把页面语义说成集合本身（我们并没有把集合当成一件作品维护）；
- `position` 从 `startPosition` 连续编号（第 2 页从 51 起）—— schema.org 要求位置在
  列表内唯一有序，写死 `1..N` 会让第 2 页与第 1 页撞位；**刻意不写 `itemListOrder`**：
  列表按「征求意见中在前、截止日期升序」排，那不是任何单一字段的升序，写了反而误导；
- 只描述**本页真实渲染**的那批条目（渲染与结构化数据用同一个 `notices` 数组）；
  序列化仍走 `serializeJsonLd`（转义 `<`）。

## 验收

- 单元（154，新增 2）：ItemList 的条目与位置一一对应、分页 `startPosition` 生效、
  `</script>` 转义；
- E2E（184，新增 1）：首页脚本块可解析、`numberOfItems` 等于本页可见条数、
  **`itemListElement` 的顺序与页面可见顺序一致**（机器读到的 = 读者看到的）、
  第 1 页位置从 1 起、第 2 页从 `PAGE_SIZE + 1` 起；
- **红检**：删掉首页的脚本块 → 断言当场变红；共享工具的 `cellNumber` 也做了直接验证
  （从 `<a href="/?month=2026-08">44</a>` 取到 **44** 而不是 2026）；
- 本地全量：单元 154 + E2E 184 全绿，typecheck / lint 干净；
- 线上核验（部署后）：第 1 页 `numberOfItems=50`、位置 `1..50`；第 2 页位置 **`51..100`**；
  末页（第 4 页）28 条、位置 `151..178`（**末位正好等于全站条目总数 178**）；
  三页的条目顺序与页面可见顺序**全部一致**、脚本块内无裸 `<`；
  筛选视图（`?month=2026-08`）也是 44 条对 44 条可见；各页面 200。

## 一个过程教训（本轮真踩了）

**红检恢复源码后必须重建本地构建**：issue #48 的红检把「区间条件」注入进去、跑完恢复，
但我没有重建 `.next`，于是后续探针跑的是**注入版产物** —— 表现是「`?from/?to` 不生效」，
我据此追了一轮假缺陷（甚至一度怀疑是 #48 的别名逻辑写错了）。真相是本地构建陈旧；
生产是从同步后的源码重建的，一直正常。**规矩：红检的注入/恢复之后，任何本地运行
（探针、单测、e2e）之前都要先 `next build`。**

## 未做（有意）

- **统计页与首页的其它结构化数据**（如 `Dataset` / `WebSite` + `SearchAction`）：
  后者能声明站内搜索入口，但站内搜索页是 noindex（#38）—— 声明一个不该被收录的入口
  收益不明，留作后续；
- **把 `stripSsrComments` 从各 e2e 里彻底删掉**：本轮用「委托共享实现」的写法
  （各文件保留同名局部函数），改动面最小；彻底删除需要改十几处调用点，收益不大。
