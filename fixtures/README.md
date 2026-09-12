# fixtures —— 源页面快照

目录约定（PRD「Testing Decisions」）：每个官方源的页面快照存放在
`fixtures/<source>/`，`<source>` 与 `src/sources/registry.ts` 中适配器的 `id`
一致，例如：

```
fixtures/
  npc/                       # 全国人大网「法律草案征求意见」（issue #3，真实感合成快照）
    list.html                # 列表页快照（含导航等噪声链接，适配器负责过滤）
    c2/c30834/*.html         # 条目详情页快照（仿 npc.gov.cn 栏目路径）
  moj/                       # 司法部征求意见系统（issue #5，卡片+表格混合版式）
    list.html                # 列表页快照（置顶卡片 + 含发布机关列的表格）
    pub/sfbgw/zqyj/*.html    # 条目详情页快照（TRS CMS 版式，面包屑机关 /
                             # 截止提示条 / 文末附件区）
  govcn/                     # 中国政府网「意见征集」栏目（issue #5，纯表格版式）
    list.html                # 列表页快照（每行带发布机关与截止日期列；
                             # 首行为转发条目，原文指向 moj 快照 —— 跨源去重场景）
    zhengce/yjzj/*.html      # 条目详情页快照（关联部门框 / 截止日期框）
  npc-law-drafts/            # issue #2 的占位快照，仅供 fixture 源站冒烟场景使用
    list.html
    detail-fl-001.html
  e2e-reminders/             # issue #7 截止提醒场景专用（截止日期 = 今天 +7 / +3 天，
    npc/                     #   条目按订阅关键词 / 领域规则设计命中与不命中对照）
      list.html
      c2/c30834/*.html
  e2e-feed/                  # issue #6 RSS feed 场景专用（条目标题含 & / < 用于
    npc/                     #   XML 转义断言，含已截止对照条目；与 npc/ 同构独立成目录）
      list.html
      c2/c30834/*.html
```

列表页快照固定为 `<source>/list.html`（抓取管线的 `SOURCES_FIXTURE_BASE`
重写即指向该路径）；详情页快照可按仿真的真实栏目路径存放子目录，快照文件
统一用 `.html` 扩展名以获得日期令牌替换（fixture 源站只对 `.html`/`.json`/
`.txt` 做文本替换）。

## 日期令牌（fixture 源站服务时替换）

快照中的 `{{CN_DATE±N}}`（→ `YYYY年M月D日`）与 `{{DATE±N}}`（→ `YYYY-MM-DD`）
由本地 fixture 源站（`tests/e2e/helpers/fixture-server.mjs`）在**每次 start() 时
锚定当天日期**替换为具体日期。截止日期等影响状态与倒计时断言的字段一律用令牌，
保证「征求意见中 / 已截止」的判定与「剩 N 天」的断言不随测试运行日期衰减；
锚定在启动时刻又保证同一次运行内多次响应内容一致（重复抓取幂等）。
发布日期等历史事实不用令牌，直接写死。

## 如何添加一个新的 fixture 源

1. 在 `fixtures/` 下新建以源 ID 命名的目录，放入该源列表页 / 详情页的 HTML 快照；
2. 在 `src/sources/registry.ts` 的 `sourceAdapters` 数组登记对应适配器；
3. 为该源写一条端到端场景（node:test，放 `tests/e2e/`）：给应用 / worker 注入
   `SOURCES_FIXTURE_BASE=<fixture 源站地址>`，抓取即被重定向到
   `<base>/<source>/list.html`，从 HTTP 层断言抓取入库结果。

快照建议只保留页面结构与关键文本（可脱敏、可截断），并在文件头注释标注来源与
快照日期。E2E 运行期间 fixture 由本地 HTTP 服务提供，不访问真实源站。
`npc/` 快照为仿真实 npc.gov.cn 页面结构的**合成数据**（含中文正文与附件链接），
其中附件文件本体不随快照提供（下载链接指向 fixture 源站会 404，仅断言其展示）。

## 本地预览

```
npm run fixtures            # 默认 127.0.0.1:4170，按 fixtures/ 目录服务
```

URL 映射：`/<source>/<file>` → `fixtures/<source>/<file>`（防路径穿越，缺失返回 404；
文本快照在服务时替换日期令牌）。
