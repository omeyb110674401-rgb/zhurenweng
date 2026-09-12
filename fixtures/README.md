# fixtures —— 源页面快照

目录约定（PRD「Testing Decisions」）：每个官方源的页面快照存放在
`fixtures/<source>/`，`<source>` 与 `src/sources/registry.ts` 中适配器的 `id`
一致，例如：

```
fixtures/
  npc-law-drafts/            # 全国人大网"法律草案征求意见"
    list.html                # 列表页快照
    detail-fl-001.html       # 详情页快照（文件名即页面标识）
```

## 如何添加一个新的 fixture 源

1. 在 `fixtures/` 下新建以源 ID 命名的目录，放入该源列表页 / 详情页的 HTML 快照；
2. 在 `src/sources/registry.ts` 的 `sourceAdapters` 数组登记对应适配器；
3. 为该源写一条端到端场景（node:test，放 `tests/e2e/`）：启动 fixture 源站
   （`tests/e2e/helpers/fixture-server.mjs`），以快照 URL 作为适配器 `listUrl`，
   从 HTTP 层断言抓取入库结果。

快照建议只保留页面结构与关键文本（可脱敏、可截断），并在文件头注释标注来源与
快照日期。E2E 运行期间 fixture 由本地 HTTP 服务提供，不访问真实源站。

## 本地预览

```
npm run fixtures            # 默认 127.0.0.1:4170，按 fixtures/ 目录服务
```

URL 映射：`/<source>/<file>` → `fixtures/<source>/<file>`（防路径穿越，缺失返回 404）。
