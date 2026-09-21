# 列表页的 URL 变体没有索引口径：首页可被无界 querystring 灌薄页（分页也无 canonical）

## 审计结论（2026-09-21）

| 检查项 | 结论 |
| --- | --- |
| 首页 / 分页 / 筛选视图的 canonical 与 robots | **缺陷**（见下） |
| `/diff` 版本对比路由的边界 | 有三处问题（见「附带审计」），但当前**不可达** —— 记录待办，本轮不改 |
| `/stats`、详情页的索引声明 | 无缺陷 —— 单地址，详情页有自指 canonical；都不带 noindex |

## 缺陷：同一类 URL，`/search` 挡了、首页没挡

issue #38 给 `/search` 加了 `noindex, follow`，理由是「`?q=…` 是无界变体（每个关键词
一个地址），内容随查询变化且高度重复 —— 收录等于往索引里灌薄页」。但**首页的
querystring 是同一个东西**，而且更宽：

- `?q=` 任意字符串（多词 AND 是 issue #33 加的能力）、`?agency=` 任意机关名
  —— 包括 issue #21 之前分享出去的复合串、以及随手敲的垃圾值，它们都会渲染出
  一页「筛选后共 0 条」；`?category=` 10 个领域、`?lead=1`、再乘上 `?page=1..4`；
- 这些页面的 **title / description 与首页完全相同**（继承 layout），内容只是列表子集。

而 issue #36 给统计页加了 **16 个机关钻取链接**指向 `/?agency=…&lead=1`、issue #39 又
多了复合串变体 —— 三个迭代里这个可爬空间一直在变大，却始终没有索引口径。线上实测
（修复前）：

```
GET /?q=意见&page=2   →  robots meta：无    canonical：无    title：主人翁 —— 政府公示与征求意见信息聚合
```

即：任何爬虫（或任何人）都能生成无穷多个「标题与首页相同、内容高度重复」的可收录页面。

## 修复

首页新增 `generateMetadata`（`src/app/page.tsx`），按「这一页是什么」分两种口径：

- **筛选视图**（`category` / `agency` / `q`，以及只带 `lead=1` 的参数变体）
  → `robots: { index: false, follow: true }`：不收录，但**保留 follow** —— 结果里的
  条目链接照常被发现（与 `/search` 完全同一处理）；
- **分页视图**（无筛选、`page > 1`）→ **自指 canonical**（`/?page=N`）且保持可收录：
  它是列表的不同切片，不是重复内容；第 1 页 canonical 指回根地址。

判断「有没有筛选、第几页」的解析抽到 `src/app/_lib/home-query.ts`，由**页面渲染与
generateMetadata 共用** —— 两处各写一份必然分叉（issue #32/#33 的教训），这里连
「筛选后共 N 条」的文案与翻页链接也走同一份 `parseHomeQuery`。

## 途中被既有 e2e 抓到的一个回归（已修）

首页一旦导出 `alternates`，**父级 layout 的同名字段被整块覆盖** —— layout 里的
RSS 自动发现（`alternates.types`，issue #6）因此在首页消失。这是 issue #6 的 e2e
（「列表页含 RSS 自动发现与可见订阅入口」）当场抓到的，不是我先想到的。修法：首页的
`alternates` 里一并给出 `types`，并在分页分支上补一条 e2e 断言（本 issue 里唯一重新
声明 `alternates` 的地方）。

## 附带审计：`/diff` 版本对比路由的边界（本轮不改，记录待办）

1. **单侧缺正文时会谎报内容变更**：`diffNoticeBodies(上一版正文, null)` 会把上一版
   每个条款都输出成 `removed` → 页面上整篇「删除」，而真相是我们这轮没抓到正文
   （详情页此时显示的是「正文未取到」）—— 两个页面互相矛盾。反向（上一版缺正文）
   则整篇「新增」。空态只在**两侧都空**时才出现，所以这个谎报没有任何提示。
   修法方向：在页面层先判可比性（任一侧无正文 → 明确说「本轮/上一轮正文未取到，
   无法对比」），并把该判定做成纯函数加单测；
2. **每个 diff 页共用 layout 的通用 title**（`/notices/<id>/diff` 的 title 与首页相同），
   且没有自己的 canonical / robots；
3. **当前不可达**：生产库 `version_of` 全空（issue #35 审计：收录窗口内没有同案多轮
   公示），diff 路由既没有入口链接也不在 sitemap —— 所以上述两点是**潜伏**缺陷，
   第一个多轮条目出现时才会暴露。这正是先记录、不抢着改的理由（改完无法线上核验）。

## 验收

- 单元（124，新增 7）：`home-query.test.mjs` 钉死解析边界 —— 数组取值、空串、
  非正整数页码回落第 1 页、未知领域值不生效、`hasFilter` 只看三个筛选维度、
  `lead=1` 只在显式传 1 时为真；
- E2E（171，新增 1）：`pagination.test.mjs` 断言首页可收录且 canonical 指根地址、
  分页视图自指 canonical 且保留可收录与 RSS 自动发现、**七种筛选变体**（领域 / 机关 /
  关键词 / 裸 lead / 筛选+页码 / 历史复合串 / 垃圾机关名）一律 `noindex, follow`
  且不给 canonical；
- **红检**：把 `generateMetadata` 退化为返回 `{}` → 新断言当场变红（「首页 canonical
  指根地址」）；另有一次真实的回归红：首页导出 alternates 后 RSS 自动发现消失，
  被 issue #6 的既有 e2e 抓住；
- 本地全量：单元 124 + E2E 171 全绿，typecheck / lint 干净；
- 线上核验（部署后）：`/` → 无 robots、canonical `https://cn101.top`、RSS 在；
  `/?page=2`、`/?page=3` → 自指 canonical、无 robots、RSS 在；`?q=` / `?agency=` /
  历史复合串 / `?category=` / `?lead=1` → 全部 `noindex, follow` 且无 canonical；
  `/stats` 与详情页不受影响（详情页仍为自指 canonical、无 noindex）；全部页面 200。

## 未做（有意）

- **不给 `/stats` 加 canonical**：它是单地址、不是参数变体，加不加都不构成重复内容问题；
- **不加 robots.txt Disallow**：Disallow 会让爬虫读不到 noindex，反而不如现在
  （可爬 + 不收录 + follow 链接）—— 与 issue #38 同一判断；
- **`/diff` 的可比性判定留作下一轮**：理由见上（当前不可达、改完无法线上核验），
  已在「附带审计」里写清修法方向。
