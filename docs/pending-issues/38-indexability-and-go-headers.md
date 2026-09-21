# 搜索结果页与退订页可被收录；/go 端点缺缓存与索引声明

## 审计结论（2026-09-21）

| 检查项 | 结论 |
| --- | --- |
| metadata 绝对地址 | 无缺陷 —— 生产无 `localhost` 泄漏，canonical / og:url / RSS 自动发现都是基于 `SITE_URL` 的绝对地址 |
| 页面缓存头 | 合理 —— `private, no-store, max-age=0, must-revalidate`（实时数据） |
| 订阅页交互 | 无缺陷 —— 邮件端口不可用时按门控隐藏表单并给 RSS 兜底（issue #17），可用时的表单流程与校验分支由 e2e 覆盖 |
| **索引声明** | **缺陷**（见下） |
| **`/go` 端点响应头** | **缺陷**（见下） |

## 缺陷 1：两类页面可被搜索引擎收录

全站**没有任何 robots meta**，而 `robots.txt` 只挡了 `/admin`、`/go/`、`/api/`：

1. **搜索结果页**（`/search?q=…`）：URL 是无界变体（每个关键词一个地址），内容随查询变化
   且高度重复 —— 收录等于往索引里灌薄页；而搜索表单就在每个页面的头部，爬虫必然发现它。
2. **退订确认页**（`/unsubscribe?token=…`）：地址里带退订 token —— 一旦被收录，
   任何人都能拿索引里的 URL **退掉别人的订阅**。

## 缺陷 2：`/go/<id>` 的 302 没有任何缓存与索引声明

`/go` 是北极星指标的计数端点。302 本身不在可启发式缓存的集合里（所以计数没被缓存吃掉），
但显式声明 `no-store` 更稳妥；同时 robots.txt 的 Disallow 之外再补一道响应头 ——
302 带不了 meta 标签，只能走响应头。

## 修复

- `/search` → `robots: { index: false, follow: true }`（follow 保留链接发现：爬虫仍会顺
  结果抓到正文页）；
- `/unsubscribe`、`/unsubscribe/done` → `noindex, nofollow`（带 token 的地址没有任何需要
  爬虫跟随的链接）；
- `/subscribe/confirmed` → `noindex, follow`；
- `/go/[id]` → 302 与错误响应都带 `cache-control: no-store`，302 另带 `x-robots-tag: noindex`；
- 顺带对齐 issue #34 之后的文案漂移：订阅确认页原写「每封邮件底部都可一键退订」，
  而邮件正文的退订链接现在会先到确认页 → 改为「都有退订入口（邮件客户端的「退订」按钮
  可直接退订）」。

## 验收

- e2e：① 冒烟测试断言四类薄页/事务页带 noindex，**并反向断言首页、统计页与正文页不带
  noindex**（防误伤）；② 统计测试的点击用例断言 `/go` 的 302 带 `cache-control: no-store`
  与 `x-robots-tag: noindex`；
- 红色证据：线上旧代码 `/search`、`/unsubscribe` 等页面 robots meta 为「无」，`/go` 的
  302 无 `cache-control`；
- 线上核验（部署后）：`/search` → `noindex, follow`；退订两页 → `noindex, nofollow`；
  `/subscribe/confirmed` → `noindex, follow`；首页 / 统计 / 正文页仍为「无」；
  `/go/<id>` → 302 + `no-store` + `noindex`；全站页面 200；
- 本地：单元 106 + E2E 165 全绿，typecheck / lint 干净。

## 未做（有意）

- **未加 JSON-LD 结构化数据**：详情页目前没有任何 `application/ld+json`。这是可发现性的
  增强项（不是缺陷），且「公示条目」用哪种 schema.org 类型需要先定语义（`Article`？
  `GovernmentService`？截止日期没有标准字段），留作独立议题；
- **未给 `/search` 加 robots.txt Disallow**：那样爬虫读不到 noindex，反而不如现在
  （可爬 + 不收录 + follow 链接）。
