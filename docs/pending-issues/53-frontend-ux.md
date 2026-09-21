# 前端体验（第四轮）：可见性、移动端与可达性

**背景**：前三轮的轴分别是「规范」（#50）、「健康与健壮性」（#51）、「信任边界」（#52）。
这一轮按产品负责人的要求换到**前端体验**：站点已上线、内容在持续更新，但呈现层从未
被系统看过一遍 —— 全站**零媒体查询**、**零图标资产**、**零跳转主内容**，而且备案号
只在 3 个页面出现。用户同时拍板两条边界：**保持零客户端 JS**、**只做响应式与细节修复**
（不做暗色模式与字号令牌化）。

审查方式与前几轮一致：三路并行探查（呈现层 / 交互与无障碍 / 性能与资源），
**每条承重结论都由我亲自读源码复核**，再据此定方案。

## 一、审查发现（均带证据，非推测）

### A. 可见性缺口

| 项 | 事实 | 证据 |
| --- | --- | --- |
| 全站零媒体查询 | `globals.css` 1305 行，`grep -c "@media"` = **0**；`overflow-wrap` 也是 0 | `src/app/globals.css` |
| 图标与分享资产全缺 | 无 `public/`、无 `icon.*` / `apple-icon.*` / og 图 / `manifest` / `themeColor`；`/favicon.ico` 实测 404（Next 不会把它映射到 `icon.svg`） | 仓库清单 + 本地 curl |
| 备案号只在 3 个页面 | 首页、搜索页、404 有；详情页、统计页、订阅链路等 9 页没有 —— 备案号应在**所有**页面底部可见，属合规缺口 | `page.tsx:411`、`search/page.tsx:209`、`not-found.tsx:35` |
| `.go-button` 用在两种元素上却只写了链接需要的属性 | 同一个类同时是 `<a>`（详情页主按钮）与 `<button>`（订阅页提交）：缺 `border: none` / `cursor: pointer` / `font-family: inherit`，于是订阅页的按钮带 UA 默认边框、光标是箭头 | `globals.css:279-288`、`subscribe/page.tsx:134` |

### B. 移动端

| 项 | 事实 | 证据 |
| --- | --- | --- |
| 公示期分布会撑破卡片 | `.period-label` 固定 150px + `.period-count` 固定 56px + 两处 10px gap → 行最小宽 ≈236px，≤300px 视口（Galaxy Fold 280px）溢出 | `globals.css:801-838` |
| 详情字段写死两列 | `grid-template-columns: 1fr 1fr`，320-560px 下每列只剩 ~110px，「全国人大常委会法制工作委员会」这类 14 字机关名折成 3-4 行 | `globals.css:215-220` |
| 同类组件两套规矩 | `.summary-head` 无 `flex-wrap`，`.brief-head` 有 | `globals.css:242-247` vs `1161-1167` |
| 触控目标普遍偏小 | chip ≈25px、分页链接 ≈27px、筛选按钮 ≈34px、订阅复选框行 ≈21px（WCAG 2.5.8 底线 24px，iOS HIG 建议 44px） | `globals.css` 各规则实算 |
| 后台宽表无横滚容器 | 7 列源健康看板在手机上把**整页**撑出横向滚动条；`.admin-bar` 也不换行 | `admin-html.ts:189`、`:31` |
| 长串无兜底 | 正文里的附件文件名（如 `P020260910579256447259.pdf`）不会折行，撑破卡片 | 生产详情页实测存在该形状 |

### C. 无障碍与结构

| 项 | 事实 | 证据 |
| --- | --- | --- |
| 零 skip link | 首页要按 Tab 依次经过搜索框、站内导航、10 个领域 chip、机关下拉与筛选按钮才到列表 | 全仓 grep 0 命中 |
| `/search` 是唯一没有 h1 的页面 | 标题层级从 `<h2 id="search-results-title">` 起；面包屑是 `<p class="breadcrumb">` 而别处是 `<nav>` | `search/page.tsx:105,112` |
| 详情页标题跳级 | `h1`（条目标题）→ `h3`（摘要分节），中间没有 h2 | `summary-view.tsx:53,94` |
| 禁用分页不可感知 | `<span class="pagination-disabled">` 无 `aria-disabled`，读屏会念出「上一页」却不说明不可用 | `page.tsx:382,399`、`search/page.tsx:180,197` |
| `aria-label` 挂在无 role 的 div 上 | `div.filter-bar[aria-label="公示筛选"]` —— 通用 div 上的 aria-label 多数辅助技术不暴露 | `page.tsx:271` |
| 筛选后头部搜索框仍为空 | 点它会带着空关键词跳到 `/search` 并丢掉全部筛选条件 | `page.tsx:217` |
| 越界页码：内容夹取、地址不夹 | `?page=999` 渲染末页内容，但地址栏与 `generateMetadata` 发出的 canonical 都还停在 `?page=999` | `page.tsx:59,163` |
| 订阅表单失败后内容全丢 | 错误经 303 回 `?error=…`，页面只渲染横幅，邮箱 / 关键词 / 勾选全部要重填 | `subscribe/page.tsx:94-131` |
| `/go` 死路回裸 JSON | 条目被合并或清掉后，读者从详情页点「去官方渠道提意见」撞见 `{"error":"未找到该公示条目"}`，无回站路径 | `go/[id]/route.ts:85,95,99` |

### D. 实现过程中抓到的两个额外真缺陷

1. **文件约定的 `og:image` 会被页面自己的 `openGraph` 整块覆盖**（新写的 e2e 当场抓到）：
   `src/app/opengraph-image.tsx` 产出的图只在「页面没有导出 openGraph」时出现 ——
   统计页与详情页都自定义了 openGraph，因此**一直没有分享图**（首页有，因为它的
   openGraph 来自 layout）。改为「静态文件 + 显式声明」后，谁覆盖都不会丢。
2. **增量同步脚本会静默改坏二进制文件**：`deploy/sync-files-local.sh` 对每个文件做
   CRLF → LF 归一，而 PNG/ICO 的压缩数据里可能恰好出现 `0x0D 0x0A` 字节对
   （实测 `og-image.png` 1 处、`favicon.ico` 3 处、`apple-icon.png` 1 处）。更糟的是
   校验用的是**同一套变换**，所以哈希会对上、文件却是坏的。已按「含 NUL 字节 → 按原始
   字节传输与校验」修掉，并让分块路径也不再无条件 `tr -d '\r'`。

## 二、逐项处置

| # | 处置 | 落点 |
| --- | --- | --- |
| 1 | 站点图标与分享资产：手写 `icon.svg`（浏览器直接渲染，任意尺寸清晰）+ 脚本产出 `favicon.ico`（16/32/48 三尺寸 ICO）、`apple-icon.png`（180）、`public/og-image.png`（1200×630）+ `manifest.ts` + `viewport.themeColor` | `scripts/gen-brand-assets.mjs`、`src/app/icon.svg`、`layout.tsx` |
| 2 | 移动端断点：`max-width: 560px` 详情字段单列 + 页边距收紧 + 品牌字号；`max-width: 420px` 公示期分布换行；`pointer: coarse` 把 chip / 分页 / 筛选按钮 / 复选框行提到 40px；长串 `overflow-wrap: anywhere`；后台源表包横滚容器、顶栏可换行 | `globals.css`、`admin-html.ts` |
| 3 | `.go-button` 补齐按钮侧属性（`border: none` / `cursor: pointer` / `font-family: inherit` / `text-align: center`） | `globals.css` |
| 4 | `.form-field > label` 收口（选项行不再被当成字段标签），删掉 `.category-option` 的 `!important` | `globals.css` |
| 5 | 越界页码 307 归一（`redirect()` 回夹取后的地址）→ 地址栏、canonical、内容三者一致 | `page.tsx` |
| 6 | 头部搜索框回填当前列表关键词 | `page.tsx` |
| 7 | `/go` 找不到条目 / 链接非法时回**能读的 HTML 页面**（含返回公示列表），`no-store` 与 `x-robots-tag: noindex` 不变 | `go/[id]/route.ts` |
| 8 | 首页提示行拆分：排序说明与 RSS / 邮件提醒入口从 `section-hint` 文字墙里拆成独立 `list-actions` 行（testid 与文案一字未改） | `page.tsx` |
| 9 | 统计页给「0 值不可点」补说明（趋势表 + 公示期分布各一句） | `stats/page.tsx` |
| 10 | skip link + 每页 `<main id="main-content">`（含后台自包含文档） | `layout.tsx`、11 个页面、`admin-html.ts` |
| 11 | `/search` 补 h1、面包屑改 `<nav>`；摘要分节 h3 → h2；禁用分页 `aria-disabled`；筛选条 `aria-label` 从 div 移到 `<form>` | `search/page.tsx`、`summary-view.tsx`、`page.tsx` |
| 12 | 抽 `SiteFooter`（免责声明 + 页内导航 + 备案号），11 处手写页脚归一 → 备案号全站可见 | `src/app/_lib/site-footer.tsx` |
| 13 | 元数据补齐：`/stats`、`/subscribe`、`/diff` 加 description 与 og:url；`og:image` 改为静态文件 + 显式声明（修 D-1） | `src/lib/page-metadata.ts`、各页 |
| 14 | 详情页 `getNoticeById` 用 React `cache()` 做请求级记忆化（此前 metadata 与渲染各查一次）；来源名与摘要列改并行 | `notices/[id]/page.tsx` |
| 15 | 订阅表单失败回填：草稿放短命 HttpOnly cookie（120 秒、`Path=/subscribe`、**不带 Secure** —— 本地与 e2e 跑 http，带上浏览器根本不写）；成功时清掉；邮箱**绝不进 URL** | `src/lib/subscribe-draft.ts`、`api/subscriptions/route.ts`、`subscribe/page.tsx` |
| 16 | 修 `deploy/sync-files-local.sh` 的二进制静默损坏（修 D-2） | `deploy/sync-files-local.sh` |

## 三、未做（有意）与理由

- **客户端 JS**：按用户选择保持零 JS。因此倒计时仍是渲染时快照 —— 代价被明确接受
  （页面同时展示确切截止日期，长开的标签页不至于误判）。
- **暗色模式 / 字号令牌化（rem）**：按用户选择不做。暗色需要先把 109 处硬编码色值 /
  39 种色收敛成变量；rem 化要动 81 处 px 字号，回归面最大。两者都登记在 FOLLOWUPS。
- **`loading.tsx` / 骨架屏**：会让 Next 走 streaming，`<!--$?-->` 与 `<template>` 标记
  会插进 HTML，而 28 个 e2e 文件大量依赖 `[^<]*` 文本提取与 indexOf 切片断言；
  风险远大于「骨架闪一下」的收益。登记。
- **`<time datetime>`**：5 处既有断言把日期当纯文本契约（`notice-brief.test.mjs:320` 的
  `fieldOf` 用 `<dd>([^<]*)</dd>`、`category-filter.test.mjs:507`、`search.test.mjs:147`、
  `sources-aggregation.test.mjs:290-295`），要做需一并改这些断言 —— 单独一轮。
- **OG 图带文字**：站名是中文，任何不带 CJK 字体的光栅化都是豆腐块，而字体子集化不在
  本轮范围。分享图因此只有几何标记。登记。
- **共享缓存 / CDN**：页面渲染实时计数（详情页出站点击数、统计页聚合），加共享缓存会让
  计数静止。登记。
- **后台表单失败回填**：与订阅页同一机制，但后台是手写 HTML 生成器（`admin-html.ts`），
  单独一轮更合适。登记。
- **详情页「出站提意点击：N 次」展示、同一 `/go` 的两个链接名、文案「分步提意指引」**：
  属产品措辞选择，且「分步提意指引」被 `npc-pipeline.test.mjs:266` 钉住 —— 本轮不动。

## 四、验证

**测试基线**：unit **196 → 203**（新增 `subscribe-draft` 7 条），e2e **200 → 219**
（新增 `brand-assets` 7 条、`mobile-and-a11y` 12 条）；`npm run lint` 与 `tsc --noEmit` 干净。

**红检（8 处，逐条确认咬中的正是预期用例）**：

| 注入 | 变红的用例 | 断言原文 |
| --- | --- | --- |
| 去掉 `.go-button` 的 `border: none` | `.go-button 同时覆盖链接与按钮两种元素` | 「.go-button 应声明 border: none」 |
| 删掉 560px 断点里的详情字段单列 | `globals.css 里有首批媒体查询` | 「窄屏下详情字段应改为单列」 |
| 页脚订阅链接改成不门控 | `首页不出现订阅入口`（#17 既有用例） | 「首页不应有任何指向 /subscribe 的链接」 |
| 统计页 `<main>` 去掉 id | `每个页面都有 skip link，且 #main-content 真的存在` | 「/stats 的 #main-content 目标应存在」 |
| `/go` 404 退回裸 JSON | `/go 找不到条目时给读者一个能读的页面` | content-type 为 `application/json` |
| 校验失败不下发草稿 cookie | `订阅校验失败后回填已填内容` | 「失败时应下发草稿 cookie」 |
| 不重定向越界页码 | `越界页码 307 归一` | `200 !== 307` |
| 把 `overflow-x: auto` 写成 `overflow: auto` | `统计页：两张宽表都包在可横向滚动的容器里`（#37 既有用例） | 证明那条老断言仍在守门，不是死断言 |

**线上核验**（cn101.top，重建 web 镜像后）：

- 五个资产路由全部 200 且 content-type 正确：`/favicon.ico`（image/x-icon, 1221B）、
  `/icon.svg`（991B）、`/apple-icon.png`（1491B）、`/og-image.png`（23663B）、
  `/manifest.webmanifest`；
- 首页 head：`rel="icon"`（ico + svg 两条）、`apple-touch-icon`、`manifest`、
  `theme-color=#b45309`、`og:image`（绝对地址）、`twitter:card=summary_large_image`；
- `/?page=999` → **307 到 `/?page=4`**（生产 4 页，夹取正确）；
- `/go/0000000000000000` → 404 + `text/html`，含「返回公示列表」；
- 首页与详情页：skip link、`id="main-content"`、页脚导航、备案号（beian.miit.gov.cn）、
  `aria-disabled` 全在；筛选条 div 上不再有 aria-label；
- 详情页 `og:url` 自指、`og:type=article`、`og:image` 存在（修好了 D-1）；
- 全站页面 200（首页 / 统计 / 订阅 / 搜索 / feed / sitemap / robots）；
- **十源真实抓取一轮**：11 个源行里 10 个 `last_success_at` 刷新为当天，185 条入库、
  无「详情失败」、无源级失败、无告警（本轮未动抓取层，跑一轮是防误伤）。

**刻意不在生产上验的**：订阅失败回填（会真的发信）—— 只由 e2e 与单测证明。

## 五、过程教训

1. **红检脚本自己会咬人**：同一文件有多条注入时，我的备份逻辑写成「每条注入前都备份」，
   于是后一条把备份覆盖成「已注入一半」的中间状态；恢复时文件看着像原文、其实少了两处
   改动（`git diff` 才发现）。已改成 `setdefault` 只备份最早那份。**恢复之后必须看 diff，
   不能只看「恢复命令跑成功了」**。
2. **同一套变换的校验等于没校验**：同步脚本对二进制做 CRLF 归一、又用同一套变换算哈希，
   于是「校验通过」与「文件正确」是两件事。凡是「本地变换 → 传输 → 远端校验」的链路，
   都要问一句「两端是不是在做同一个变换」。
3. **文件约定的元数据会被页面级元数据覆盖**：`opengraph-image.tsx` 的图在页面导出
   `openGraph` 时消失 —— 这是写测试时才发现的，说明**新写断言比读文档更能发现问题**。
