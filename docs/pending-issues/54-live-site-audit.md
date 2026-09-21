# 线上体检（第五轮）：以实测为准的九项修复

**背景**：前四轮的轴分别是「规范」（#50）、「健康与健壮性」（#51）、「信任边界」（#52）、
「前端体验」（#53），全部是**读源码**的审计。这一轮换轴：站点已在 `cn101.top` 跑起来、
内容每天在变，于是对着**运行中的生产环境**做一遍实测 —— 结论只认 curl 与浏览器量到的
数字，源码里的说法一律要拿线上证据对一遍。

审查方式：线上探测（HTTP 头 / 缓存 / 体积 / SEO 产物 / 数据自洽性）+ 浏览器走查
（对比度实算、真实 Tab 焦点、点击区实测）+ 两路源码探查，**每条承重结论都由我亲自
复核线上证据**。

## 一、线上确认健康的部分（写下来，免得下轮重复查）

| 项 | 实测 |
| --- | --- |
| 数据新鲜度 | feed 最新 pubDate = 审查当日；2026-09 收录 51 条、08 月 44 条，抓取在跑 |
| 状态与排序自洽 | 第 1 页 50 条全部未过期（6 条「今天截止」），第 2 页起才出现「已截止」；全局「进行中升序 → 已截止升序」口径正确 |
| 安全头 | HSTS / nosniff / X-Frame-Options DENY / Referrer-Policy / Permissions-Policy 齐备；www 301 归一、HTTP→HTTPS 308 |
| 出站跳转 | `/go/<id>` 302 到官方原文且带 `X-Robots-Tag: noindex`（#38 闭环）；外链全部 `rel="noopener noreferrer"` |
| SEO 产物 | RSS 185 条 XML 可解析、无裸 `&`；sitemap 187 URL、lastmod 是 107 个不同真实日期 |
| 文字对比度 | 全站实测仅 1 处低于 AA：`.pagination-disabled` 2.43:1，属禁用态豁免 |
| 焦点可见性 | 真实 Tab 下 `:focus-visible` 命中、UA 默认环可见；无 `outline:none`；全站无动画故不需要 `prefers-reduced-motion` |
| 越界与非法输入 | `?page=99` 夹到末页、`?page=abc` 回落首页，均不报错；空结果与 404 都有引导文案 |

## 二、修复项

### 1. [P0] 分页边界重复一条、挤掉一条 —— 收录内容从导航不可达

**线上事实**：`?page=1` 的末条与 `?page=2` 的首条是同一条目（`e32f5495687f2200`），
连续 5 次请求稳定复现；另一条 `ae391c30a5566956` 在 4 个页面上**都找不到**，却存在于
feed 与 sitemap 里。列表 185 个槽位只覆盖 184 个唯一条目。

**根因**：`AGGREGATION_ORDER` 的四个排序键（status / 有无截止 / deadline / fetchedAt）
**没有一个唯一** —— `fetchedAt` 是本轮抓取的批次时间戳，同轮入库的条目三项全等。
这两条并列条目恰好坐在第 1 / 2 页边界上。`ORDER BY … LIMIT 50 OFFSET 0` 与
`LIMIT 50 OFFSET 50` 是两次独立查询，PostgreSQL 的有界 top-N 排序对并列行的解析结果
随取的 N 变化 → 同一条在两页各占一席，另一条被挤出全集。库里现有 **22 组**这样的并列
（最大一组 6 条），任何页边界落进并列组内都会复发。

**修复**：`src/db/repo/notices.ts` 的 `AGGREGATION_ORDER` 末位补 `asc(notices.id)`
（id 由原文 URL 的 sha256 前缀确定性生成，天然唯一且稳定），让排序构成全序。

### 2. [P0] 404 页把运行时配置固化成了构建期的值

**线上事实**：`https://cn101.top/nope` 页脚显示「ICP 备案：待备案（占位）」，同域其它
页面显示真实备案号 `湘ICP备2026041773`；`/notices/<无效id>` 的 404 却是正确号码。
同一页脚还挂着「订阅提醒」入口，而其它页面按生产配置把它隐藏了。

**根因**：根 `not-found.tsx` 没有声明 `dynamic`，被 Next **构建期预渲染**，于是页脚里
两处运行时判断（`IcpFiling` 读 `process.env.ICP_NUMBER`、`SiteFooter` 调
`mailerReady()`）全部固化成构建期的值。全站其它页面靠各自的 `force-dynamic` 避开了这个
坑（`icp-filing.tsx` 的注释甚至写明了这条前提），但根 not-found 不在任何页面的路由段里。

**修复**：`not-found.tsx` 声明 `force-dynamic`。**顺带把同类风险查干净**：逐个入口核对
「读运行时环境 / 门控」与「是否声明 dynamic」的交叉，发现 `manifest.ts` 同样没有声明
（它当时恰好不读环境所以没暴露），一并补上。其余 24 个入口本就有 `force-dynamic`。

### 3. [P1] 首页 JSON-LD 与页面可见内容自相矛盾

**线上事实**：`ItemList` 的 `numberOfItems` = 50，同页可见「共 185 条」；而
`itemListElement` 的 `position` 是按整份列表连续编号的（第 2 页从 51 起）—— 等于声明
「这份列表共 50 件」同时给出「第 51 件」的位置。

**修复**：`buildNoticeListJsonLd` 增加 `totalItems` 入参，首页传 `count` 查询的真实合计。

**这是一次有意的口径推翻**：issue #49 当初把 `numberOfItems` 定为「本页可见条数」并写进
e2e 断言（`pagination.test.mjs` 原文「numberOfItems 必须等于本页可见条数」）。问题在于
#49 同时用了全局 `position`，两个决定合在一起不自洽。本轮选择「ItemList 描述整份列表、
itemListElement 是本页切片」这一种自洽读法，并改了那条断言、在断言旁写明理由。

### 4. [P1] 全站文案承诺了未启用的 AI 摘要

**线上事实**：站点 `description` 写着「用 AI 摘要帮你发现、读懂、参与」，抽样 **20/20**
的详情页显示「AI 结构化解读尚未启用（未配置大模型端口）」；`manifest.ts` 的 PWA 描述
同样。LLM/SMTP 未配置本身已登记在 `FOLLOWUPS.md` 待决定，**本轮的新问题是文案在功能
未开的情况下做了对外承诺**。

**修复**：`layout.tsx` 的 description、`manifest.ts` 的描述、`site-footer.tsx` 的
「AI 生成内容将显著标注」三处一律按 `llmReady()` 取版本 —— 与详情页 AI 摘要区块用的是
同一个门控（该门控 issue #22 就存在），配好密钥后自动恢复原措辞，不必再改代码。
未启用时的文案只陈述站点真实在做的事（官方原文聚合 + 程序逐字摘录 + 截止倒计时）。

### 5. [P1] 根目录静态资源每次访问都回源

**线上事实**：`/_next/static/*` 是 `immutable`（正确），但 `/favicon.ico`、`/icon.svg`、
`/apple-icon.png`、`/og-image.png`、`/robots.txt`、`/sitemap.xml` 全是 `max-age=0`。
本站没有 CDN、Caddy 只做 `encode + reverse_proxy`，所以「回源」就是真的打到 Node 进程。

**修复**：`next.config.ts` 的 `headers()` 按路径追加缓存头 —— 品牌资产 1 天（文件名不带
hash 且 favicon 的名字是规范固定的，没有「换名即失效」的退路，故不给长 TTL）、
robots/sitemap 1 小时（附带把 sitemap 每次请求的全表扫摊薄成每小时一次）。
`/feed.xml` 明确排除，保持 `no-store`。

### 6. [P1] 错误响应丢了 noindex 声明

**线上事实**：`/nope` 与 `/notices/deadbeef…` 的 404 响应都没有 `X-Robots-Tag`。
同文件的 302 有（#38 的成果），但 `errorPage()` 只带了 `no-store`。

**修复**：`errorPage()` 复用 302 那一份头常量，两边不会各自漂移。

### 7. [P2] 表单控件边框不满足非文本对比

`--line` 原值 `#e5e7eb` 对白底 1.24:1。WCAG 1.4.11 的 3:1 只约束「识别控件所必需的
边界」，而 `--line` 全站 23 处引用里绝大多数是装饰性的（卡片边框、表格线、页眉页脚分隔、
领域 chip、进度条）。

**修复**：拆出 `--line-control: #919191`（在白底 3.15:1、对 `--paper` 3.01:1，是双双过
3:1 的最浅中性灰），**只**给 `.search-input`、`.filter-keyword`、`.filter-agency`、
`.form-field input` 四处用上；`--line` 保持原值。

（探查阶段曾提出直接把 `--line` 改成 `#919191`，会把 19 处装饰边框一起拖深、整站每个
表面描一圈中灰，故收窄。附带更正：直觉上的 gray-300 `#d1d5db` 实测只有 1.41:1，
根本不到 3:1。）

### 8. [P2] 统计页两张表没有可访问名称

读屏进到表格里只会念「表格」。`th scope` 本来就齐全，缺的是 caption。

**修复**：两张表各加 `<caption className="sr-only">`（文案与紧邻的 h2 重复，故视觉隐藏；
趋势表的 caption 带真实月份窗口）。全站原本没有 `.sr-only` 工具类，新增一条
（1px clip 裁剪，不用 `display:none` —— 那会把内容连无障碍树一起摘掉）。

### 9. [P2] 触屏下页脚与站内导航的文字链接点击区过小

实测页脚「数据统计」高 18px、「RSS 订阅」17px。既有的 `@media (pointer:coarse)` 只放大了
chip / 翻页 / 按钮。

**修复**：同一 coarse 块内给 `.footer-nav a`、`.site-nav a`、`.rss-link` 补
`inline-block + min-height:40px + padding`，桌面端零影响；正文句中链接与统计钻取数字
刻意排除（撑高会拉乱行距 / 把横滚容器撑出空行）。

## 三、未做（有意）与理由

| 项 | 为什么不做 |
| --- | --- |
| 给 HTML 页面加缓存头 | 没有 CDN、Caddy 不缓存 → `s-maxage` 无人读，写了是空操作；而 `max-age` 落在浏览器私有缓存上，对「倒计时截止日期」站点等于让用户看到过期状态。要上共享缓存得先解决页面里的实时计数（FOLLOWUPS 已登记） |
| 配置 GLM / SMTP | 属凭据与服务商选型，是 `FOLLOWUPS.md` 里的待决定项，不是代码问题。本轮只把文案改成与功能一致 |
| 深色模式、85 处 px 字号令牌化 | #53 已明确划为边界外，本轮沿用 |
| 禁用的「上一页」2.43:1 | 禁用态属 WCAG 1.4.3 豁免 |
| `/stats`、`/subscribe` 无 canonical | #41/#38 的有意取舍，本轮复核后维持 |
| 非索引页继承首页标题 | `/search`、确认/退订各页都带 noindex，SEO 无害；只是浏览器标签页无法区分，属观感 |
| HTTP/2 是否启用 | **未能验证**：本地 curl 的 libcurl 不支持 ALPN h2（对照 baidu 也返回 1.1），换工具前不下结论 |

## 四、验证

`npm test` = **204 单测 + 221 e2e 全绿**，`npx tsc --noEmit` 干净。新增/改动的断言：

- `tests/unit/notice-jsonld.test.mjs`：`numberOfItems` 取全量合计、缺省回落本页条数。
- `tests/e2e/pagination.test.mjs`：改写了 #49 那条 `numberOfItems` 断言；新增「排序键完全
  并列时分页切片仍是一次划分」。
- `tests/e2e/smoke.test.mjs`：注入 `ICP_NUMBER`，断言 404 页页脚取到运行时备案号、
  不得出现「待备案（占位）」。这条同时兜住 `mailerReady()` 那半个症状（同一渲染路径）。

**必须说清楚的一条**：并列排序那条 e2e 用例在**修复前也通过** —— 实测过（摘掉
`asc(notices.id)` 重新 `next build` 后仍全绿）。SQLite 对小规模并列集的排序结果恰好与
N 无关，复现不了症状；线上出问题的是 PostgreSQL 的有界 top-N 排序。所以那条用例锁的是
不变量，**不是 #54 事故的复现脚本**。事故侧的验收要在生产上做：

```bash
# 上线后跑：跨页并集的唯一 id 数必须等于「共 N 条」，且相邻页边界不得是同一条目
python - <<'EOF'
import re, urllib.request
def g(u): return urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent':'v/1'})).read().decode('utf8','replace')
tot = int(re.search(r'共 (\d+) 条', re.sub(r'<[^>]+>',' ', g('https://cn101.top/'))).group(1))
pages = [re.findall(r'href="/notices/([0-9a-f]+)"', g('https://cn101.top/' if i==1 else f'https://cn101.top/?page={i}'))
         for i in range(1, (tot + 49)//50 + 1)]
flat = [x for p in pages for x in p]
assert len(flat) == tot, f"槽位 {len(flat)} != 合计 {tot}"
assert len(set(flat)) == tot, f"唯一 {len(set(flat))} != 合计 {tot}（仍有重复/漏行）"
for i in range(1, len(pages)): assert pages[i-1][-1] != pages[i][0], f"第 {i}/{i+1} 页边界重复"
print("OK：分页一次划分成立")
EOF
```

## 五、过程教训

1. **源码审计的结论必须拿线上证据过一遍，否则会写进假问题。** 本轮源码探查给出的两条
   SEO 结论被线上实测否掉了：一是「`og:url` 与 canonical 不一致」—— 实测两者都是
   `https://cn101.top`，完全一致；二是「详情页 `og:image` 可能缺失」—— 实测是完整的
   绝对 URL。根因是仓库里留着十几个 `.live-*.html` 抓取件，它们是 issue #53 **之前**的
   构建产物，拿它们当「现状」就会得出过期结论。下轮要么先删这批文件，要么明确禁止
   把它们当证据。
2. **回归测试要验证它真的会红。** 并列排序那条用例如果不做「摘掉修复再跑一遍」，
   就会被当成事故的防线写进注释 —— 而它其实挡不住这个事故。跨方言的项目里尤其容易踩：
   测试跑 SQLite、生产跑 PostgreSQL。
3. **`npm run lint` 在 main 上是红的**（`scripts/gen-brand-assets.mjs:111` 两个未使用
   变量），与本轮无关。推测是 GitHub 账号停用后 CI 再没跑过。属独立问题，未在本轮处理。
