# fixtures —— 源页面快照

目录约定（PRD「Testing Decisions」）：每个官方源的页面快照存放在
`fixtures/<source>/`，`<source>` 与 `src/sources/registry.ts` 中适配器的 `id`
一致，例如（issue #14 起三个源都改成**真实站点结构**的快照）：

```
fixtures/
  npc/                       # 全国人大网「法律草案征求意见」（真实结构，2026-09-20 服务器实抓）
    list.json                # 列表快照 = flca-list JSON 接口响应（本源列表页是前端渲染，
                             #   适配器直接消费接口；_snapshot 字段记录来源与裁剪说明）
    flca/<flxxId>/info/      # 详情内容快照 = 详情接口响应；目录式路径由 fixture 源站
      index.json             #   映射到 index.json（真实接口地址形如 …/flca/<id>/info/）
  moj/                       # 司法部「立法意见征集」（真实结构 + 真实正文裁剪）
    list.html                # 列表快照：ul.newsMsgList_zzy > li（日期 + 截断标题）
    pub/sfbgw/lfyjzj/lflfyjzj/*/*.html   # 详情快照：h1 / .sT / .news_content_style > .TRS_Editor
                             #   第 4 条为场景合成的转发条目（原文 URL 指向 mee 快照）
  mee/                       # 生态环境部「意见征集」（真实结构，替代已下线的 govcn）
    list.html                # 列表快照：li > a + span.date（导航项无日期，被适配器过滤）
    hdjl/yjzj/zjyj/*/*.shtml # 详情快照（栏目内页模板：h2.neiright_Title + .neiright_JPZ_GK_CP）
    xxgk2018/xxgk/xxgk06/*/*.html        # 详情快照（政府信息公开模板：h1 + 「发布机关」+ .content_body_box）
  npc-law-drafts/            # issue #2 的占位快照，仅供 fixture 源站冒烟场景使用
    list.html
    detail-fl-001.html
  e2e-mohurd/                # issue #28 住建部扩源场景专用（独立成 fixture 根目录，
    mohurd/                  #   不动 e2e-sources 那套精确计数断言）
      list.json              #   住房城乡建设部「征求意见」：list.json = TRS jpaas 接口响应，
                             #   列表行 li.long-deta 自带截止日期（span.date-info），
                             #   href 改成相对路径；保留 3 行（2 进行中 + 1 已截止）
      gongkai/zc/wjk/art/2026/*.html   # 详情：.editor-content 正文 + .editorContent-download
                             #   附件（下载接口链接无扩展名）；meta PubDate 提供发布日期，
                             #   ArticleTitle 带源站换行（适配器刻意不用它覆盖标题）
  e2e-reminders/             # issue #7 截止提醒场景专用（截止日期 = 今天 +7 / +3 天，
    npc/                     #   条目按订阅关键词 / 领域规则设计命中与不命中对照；
      list.json              #   结构与 fixtures/npc/ 同构，内容为场景合成数据）
      flca/<lid>/info/index.json
  e2e-feed/                  # issue #6 RSS feed 场景专用（条目标题含 & / <，含已截止
    npc/                     #   对照条目；与 npc/ 同构、独立成目录）
      list.json
      flca/<lid>/info/index.json
  e2e-versions/              # issue #10 版本链与条款对比场景专用（同一法案两轮公示：
    npc/                     #   标题措辞不同、正文有增删改；另含一条无关单轮条目）
      list.json
      flca/<lid>/info/index.json
  e2e-stats/                 # issue #11 统计页场景专用（三源同构、独立成 fixture 根目录；
    npc/                     #   发布与截止日期全用令牌 —— 公示期差值恒定，发布月份
    moj/                     #   恒落在最近 6 个月窗口）
    mee/
  e2e-sources/               # issue #18 M2 扩源场景专用（四个新源，独立成 fixture 根目录）
    samr/                    #   市场监管总局「征集调查」：list.json = TRS jpaas 接口响应，
      list.json              #   列表行自带征集期（{{DATE±N}}）与状态列 (进行中)/(已结束)
      hd/zjdc/art/2026/*.html      # 详情：.Three_xilan_07 正文 + 附件清单 ul.contentLeft0102box
    miit/                    #   工业和信息化部「意见征集」：list.json 同上（参数不同），
      list.json              #   截止日期在隐藏字段 span.endtime（{{EPOCH±N}} 毫秒时间戳令牌）
      gzcy/yjzj/art/2026/*.html    # 详情：#con_con 正文（含 pdf 附件链接）
    mot/                     #   交通运输部「意见征集」：list.html 静态列表，状态标注
      list.html              #   [进行中]/[已结束] 是列表判据；含两条场景合成条目
                             #   （跨域条目、标注与截止日期冲突条目）与一条被过滤的
                             #   非征求意见条目（反馈情况）—— 详见 list.html 内注释
      hudong/yijianzhengji/*/*.html
      foreign/caac-t20260908.html  # 跨域条目指向的「其它站点模板」详情页（解析不到正文）
    moe/                     #   教育部「征求意见」：list.html 静态列表，标题取 title 属性
      list.html              #   （联合发布条目的链接文本被截断）；历史归档，不用令牌
      jyb_xwfb/s248/*/*.html
    ndrc/                    #   国家发展改革委「意见征求」：链式跳转源（issue #20），
      list.html              #   条目 href 写成 <条目目录>/sa.html#/<shortKey>，后续两跳
      i1/ i2/ …              #   各落在自己的目录里（fixture 源站按路径映射、不认查询串）
        public/submission-service/article/access-url        # 第 2 跳：接口响应（无扩展名，
                                                            #   源站按文本提供并替换令牌）
        public/submission-service/column/getArticleDetail   # 第 3 跳：正文接口响应
      i5/                    #   i5 = 场景合成的「链断掉」锚点（access-url 响应缺
                             #   articleId → 抓取层记日志并降级保留列表层数据）
```

无扩展名的快照文件（真实数据接口路径就无扩展名）由 fixture 源站按文本提供，
同样做日期令牌替换。

## 快照命名与路径约定

- **列表快照**：默认 `<source>/list.html`；本源列表本身是 JSON 接口的源用
  `<source>/list.json`（适配器以 `SourceAdapter.listFixturePath` 声明）。
  抓取管线的 `SOURCES_FIXTURE_BASE` 重写即指向该路径。
- **详情快照**：按**真实栏目路径**存放（去掉协议与域名，前面加 `<source>/`），
  如 `fixtures/moj/pub/sfbgw/lfyjzj/lflfyjzj/202603/t20260320_532981.html`。
  列表快照里的链接据此书写：跨源转发条目写完整路径（`/mee/xxgk2018/…`），
  同源条目写相对源根的相对路径（`hdjl/yjzj/zjyj/…`）—— 相对链接解析本身也是
  适配器要处理的一环（真实站点混用 `./…` 与 `../../…`）。
- **目录式接口路径**：URL 以 `/` 结尾（真实接口如 `…/flca/<id>/info/`）时，
  fixture 源站映射到该目录下的 `index.json` / `index.html`。
- **扩展名**：`.html` / `.shtml` / `.json` / `.txt` 都会在服务时做日期令牌替换
  （`.shtml` 是政府 CMS 常用扩展名，如生态环境部栏目内页）。
- **WAF cookie 挑战（可选）**：源目录里放一个名为 `waf-cookie-challenge` 的空标记
  文件，fixture 源站即对该源的**列表请求**模拟司法部站点的行为：未带 cookie 时返回
  302 + `Set-Cookie` 且 Location 指回同一地址，带 cookie 重放才返回内容。
  `fixtures/moj/` 已启用（真实站点确实如此，抓取层 `fetch.cookieChallenge` 负责重放）。

## 快照来源与裁剪标注

真实抓回的 JSON 快照带 `_snapshot` 字段（`source` 原始地址 / `capturedAt` 抓取日期 /
`note` 裁剪说明），HTML 快照在文件头注释里写明同样内容。适配器忽略未知字段，
因此标注不影响解析。裁剪原则：只保留页面结构与关键文本（正文可截断）、
标题与 ID 尽量用真实值、截止日期换成令牌、单个文件远小于 200KB。

## 日期令牌（fixture 源站服务时替换）

快照中的 `{{CN_DATE±N}}`（→ `YYYY年M月D日`）、`{{DATE±N}}`（→ `YYYY-MM-DD`）与
`{{EPOCH±N}}`（→ 当天 00:00 UTC 的**毫秒时间戳**，供工业和信息化部列表的
`span.endtime` 隐藏字段使用）
由本地 fixture 源站（`tests/e2e/helpers/fixture-server.mjs`）在**每次 start() 时
锚定当天日期**替换为具体日期。截止日期等影响状态与倒计时断言的字段一律用令牌，
保证「征求意见中 / 已截止」的判定与「剩 N 天」的断言不随测试运行日期衰减；
锚定在启动时刻又保证同一次运行内多次响应内容一致（重复抓取幂等）。
发布日期等历史事实不用令牌，直接写死（例外：`e2e-stats/` 的发布日期也用令牌
—— 统计页「公示量月度趋势」断言要求发布月份相对运行日期恒定）。

## 如何添加一个新的 fixture 源

1. 在 `fixtures/` 下新建以源 ID 命名的目录，放入该源列表页 / 详情页快照
   （真实站点结构优先；列表为接口的源用 `list.json`）；
2. 在 `src/sources/registry.ts` 的 `sourceAdapters` 数组登记对应适配器；
3. 为该源写一条端到端场景（node:test，放 `tests/e2e/`）：给应用 / worker 注入
   `SOURCES_FIXTURE_BASE=<fixture 源站地址>`，抓取即被重定向到
   `<base>/<source>/<listFixturePath ?? list.html>`，从 HTTP 层断言抓取入库结果。

快照只保留结构与关键文本（可脱敏、可截断），并在文件头注释 / `_snapshot`
标注来源与快照日期。E2E 运行期间 fixture 由本地 HTTP 服务提供，不访问真实源站。
附件文件本体不随快照提供（下载链接指向 fixture 源站会 404，仅断言其展示）。

抓回真实页面并裁剪的过程可复现：`node scripts/capture-m2-fixtures.mjs [源ID…]`
（一次性脚本，只在更新快照时手动跑；需要联网访问真实政府站点）。它保留了
「真实选择器在快照里仍然命中」这一约束 —— 例如教育部详情要保留 `.moe-detail-box`
容器**本体**而不是它的后代，否则祖先 class 丢失、快照就测不到适配器用的后代选择器。
另注意：列表快照里的 href 要写成**相对源根的相对路径**（真实页面可能是站内绝对路径
`/hd/zjdc/…` 或 `./202609/…`），使「相对列表地址解析」在 fixture 源站内落位；
真实形态写在快照注释里。

## 本地预览

```
npm run fixtures            # 默认 127.0.0.1:4170，按 fixtures/ 目录服务
```

URL 映射：`/<source>/<file>` → `fixtures/<source>/<file>`（防路径穿越，缺失返回 404；
文本快照在服务时替换日期令牌）。
