# 详情页加 JSON-LD 结构化数据；首页机关下拉与筛选值不一致

## 审计结论（2026-09-21）

| 检查项 | 结论 |
| --- | --- |
| 首屏性能 | 无缺陷 —— JS 173KB（压缩后，8 个 chunk）、CSS 3.3KB、首页 HTML 13.9KB（gzip）；Caddy 已 `encode zstd gzip`；`'use client'` 计数 0（框架自身 JS，业务代码零客户端组件）；首页 TTFB+下载约 328ms，/stats 150ms，详情页 105ms |
| 详情页结构化数据 | 缺失 —— 全站没有任何 `application/ld+json`（issue #38 有意留的增强项，本轮补） |
| **首页机关下拉** | **缺陷**（见下） |

## 缺陷：机关下拉显示的与列表实际筛的不是一回事

issue #21 把机关下拉的选项口径从 `agency` 原值改成了**参与机关**集合（联合发文
「司法部、中国人民银行、金融监管总局、中国证监会、国家外汇局」在下拉里拆成 5 个
可单独选中的机关）。库内 `agency` 列没变，于是 **issue #21 之前被分享出去的链接
仍然带着复合串值**。线上实测（修复前）：

```
GET /?agency=司法部、中国人民银行、金融监管总局、中国证监会、国家外汇局
→ 筛选后共 1 条（机关：司法部、中国人民银行、金融监管总局、中国证监会、国家外汇局）。
→ <select> 共 22 个选项，无该值，且**没有任何 option 带 selected**
```

`<select defaultValue={agency}>` 匹配不到任何选项时，浏览器回落到首项 —— 于是下拉
显示「全部机关」，而列表已经按该值筛过。**筛选控件在说谎**：用户看到的是「没筛」，
实际是「筛了」。同类取值还包括 `?agency=生态环境部`（issue #21 统一为「生态环境部
办公厅」之前的写法）。

## 修复

### 1. 机关下拉补上当前筛选值（`src/app/page.tsx`）

```ts
const agencyOptions =
  agency !== undefined && !agencies.includes(agency) ? [agency, ...agencies] : agencies;
```

补进来的选项放在最前，用户一眼看到当前生效的是哪个值；值在库内时选项集合完全不变
（不为常规筛选多造选项，由 e2e 反向断言）。

### 2. 详情页 JSON-LD（`src/lib/notice-jsonld.ts` + 详情页渲染）

- **类型选 `Article`**：本页就是一份文档页（公示正文 + 附件 + 截止日期）。`Event`
  要求 `location`（这些公示没有线下场地），`GovernmentService` 指「一项持续提供的
  服务」，两者都会把页面说成它不是的东西；
- **法规用 `about: Legislation`**：标题里《…》括起来的文件名（复用速读卡的
  `extractDocumentNames`，两处口径不分叉），可能有「征求意见稿 + 起草说明」多个；
- **截止日期给两条**：`expires`（schema.org 没有「征求意见截止」属性，`expires`
  语义最近）+ `additionalProperty: 征求意见截止日期`（逐字给名字，消费方不必猜）；
- **`creativeWorkStatus`** 用页面同一套中文文案（征求意见中 / 已截止 / 已出结果）；
- **`author` = 发布机关，`publisher` = 本站，`isBasedOn` = 官方原文页**（聚合内容的
  出处，合规姿态与页面一致）；
- **取不到的字段整个属性省略**（不写 `null` / 空串）—— 结构化数据里的空值会被消费方
  读成「已知为空」（例如「该公示没有截止日期」），比缺属性更糟；
- **序列化转义 `<`**：标题与正文摘自政府页面，出现 `</script>` 会提前闭合脚本块
  （既是结构化数据损坏也是注入面）；JSON 里 `<` 没有语义，写成 `\u003c` 解析结果不变。

## 验收

- 单元（新增 5 项，`tests/unit/notice-jsonld.test.mjs`）：字段齐备与口径、缺值省略、
  状态三态映射、多个《…》、`</script>` 转义；**红检**：把「省略」改成写 `null`、把
  转义去掉 → 两项各自变红；
- E2E（新增 5 项）：① `tests/e2e/category-filter.test.mjs` —— 复合串筛选值时下拉必须
  含该选项且处于选中态，库内值时选项数量不变；② `tests/e2e/notice-brief.test.mjs` ——
  JSON-LD 可解析且**每个字段都从页面可见内容反查**（headline / author / datePublished /
  expires / creativeWorkStatus / isBasedOn / url 与 canonical 一致 / about），脚本块内
  无裸 `<`，无截止日期的条目省略 `expires` 但照常给出法规与发布日期；
- **红检（E2E 接线）**：同时删掉页面里的 `<script>` 块、把 `agencyOptions` 改回
  `agencies` → 恰好 4 项变红（1 + 3），恢复后全绿；
- 本地全量：单元 111 + E2E 170 全绿，typecheck / lint 干净；
- 线上核验（部署后）：真实条目页 JSON-LD 可解析且字段与页面一致；复合串筛选值的下拉
  显示该值；全站页面 200。

## 未做（有意）

- **未加首页 `ItemList` / `CollectionPage`**：首页是分页列表，`ItemList` 的语义收益
  小于详情页（列表页的主要消费场景是爬虫顺链，链接已经在 HTML 里）；留作独立议题；
- **未给统计页加月份筛选**：趋势表的钻取还停在「按机关」，月份维度需要先定 URL 口径。
