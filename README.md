# 主人翁（zhurenweng）

政府公示与征求意见信息聚合网站：把分散在官方渠道的国家级公示 / 征求意见稿聚合起来，
用 AI 摘要帮助公众「**发现 → 读懂 → 行动**」，行动指引永远指向官方渠道提交意见。

- PRD：`docs/prd/v1.md`
- 架构裁决：`docs/adr/0001-local-dev-without-docker.md`（开发与测试环境脱离 Docker）

## 技术栈

- **Web**：Next.js（App Router）+ TypeScript，服务端渲染为主
- **Worker**：与 web 同仓的 Node 后台任务进程（`worker/`），任务经注册表调度
- **数据访问**：Drizzle ORM，双方言（开发 / 测试 = SQLite 文件库，生产 = PostgreSQL）；
  SQL 只用双方言交集子集，JSON 一律存 TEXT 列
- **测试**：node:test 两层 —— 单元层（`npm run test:unit`，规则表等纯函数，Node 原生
  类型擦除直接 import TS，无需构建）与端到端层（`npm run e2e`：`next build` + 本地
  fixture 源站 + stub LLM / stub 邮件，从 HTTP 层驱动真实管线缝）；`npm test` 依次
  跑两层，**不依赖 Docker 与任何外部服务**

## 目录结构

```
src/app/        Next.js 应用（列表 / 详情 /go/<id> 出站跳转）
src/db/         数据层：schema（sqlite / postgres 镜像）、client、repo
src/lib/        端口接口（ports.ts）、日期工具（dates.ts）与适配器（stubs）
src/sources/    源适配器注册表 + adapters/（数据接入唯一扩展点）
worker/         worker 进程：registry.ts（任务注册表）+ index.ts（主循环）+ jobs/（抓取等任务）
fixtures/       各源页面快照，fixtures/<source>/list.{html,json} 与详情快照
tests/e2e/      端到端测试（node:test）与 fixture 源站 helper
scripts/        fixture 源站 CLI、迁移 CLI
drizzle/        按方言生成的迁移（sqlite/、pg/）
```

## 本地启动

要求 Node.js >= 22.18（本项目在 Node 24 开发）。

```bash
npm install
npm run dev            # http://localhost:3000
```

默认使用 SQLite 文件库（`data/zhurenweng.db`，已在 .gitignore），首次访问自动建表。
常用环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DB_DRIVER` | `sqlite` | `sqlite` 或 `postgres` |
| `DATABASE_URL` | `data/zhurenweng.db` | SQLite 文件路径或 PG 连接串 |
| `LLM_PROVIDER` | `stub` | `stub`（固定摘要，可注入失败）/ `glm`（智谱 GLM 系列，需 `GLM_API_KEY`） |
| `GLM_API_KEY` / `GLM_API_BASE` / `GLM_MODEL` | （空）/ `https://open.bigmodel.cn/api/paas/v4` / `glm-4-flash` | GLM 大模型接入配置（`LLM_PROVIDER=glm` 时必填 Key） |
| `LLM_STUB_FAILURES` / `LLM_STUB_CALLS_FILE` | （空） | stub LLM 注入失败（前 N 次调用抛错，或 `always`）/ stub 调用日志 JSONL（跨进程断言调用次数） |
| `SUMMARY_MAX_RETRIES` / `SUMMARY_RETRY_DELAY_MS` | `3` / `500` | 摘要失败重试次数 / 指数退避基数（毫秒） |
| `MAILER_PROVIDER` | `stub` | `stub`（捕获邮件）/ `smtp`（nodemailer 生产实现） |
| `MAILER_OUTBOX_FILE` | （空） | stub 邮件追加写入的 JSONL 文件，供跨进程断言 |
| `SEARCH_PROVIDER` | `local` | `local`（本地实现：SQLite FTS5 / PG ILIKE 退化）/ `meilisearch`（生产检索后端，issue #8） |
| `MEILI_HOST` / `MEILI_API_KEY` | （空） | `SEARCH_PROVIDER=meilisearch` 时的服务地址与 API 密钥（`MEILI_HOST` 必填；兼容 docker-compose 的 `MEILI_URL` / `MEILI_MASTER_KEY` 命名） |
| `MEILI_INDEX_UID` / `MEILI_TASK_TIMEOUT_MS` | `notices` / `10000` | Meilisearch 索引 uid / 异步索引任务等待上限（毫秒） |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` | （空） | `MAILER_PROVIDER=smtp` 时的 SMTP 接入配置（`SMTP_SECURE=1` 走 TLS 直连，端口 465 默认 TLS） |
| `APP_BASE_URL` | `http://localhost:3000` | 邮件内确认 / 退订 / 详情链接的站点基础地址 |
| `SITE_URL` | `http://localhost:3000` | RSS feed 内站点链接 / 条目链接的对外绝对地址（issue #6，与 `APP_BASE_URL` 各司其职，见「RSS Feed」） |
| `FIXTURES_DIR` / `FIXTURE_SERVER_PORT` | `fixtures/` / `4170` | fixture 源站目录与端口 |
| `LIST_PAGE_SIZE` | `50` | 首页每页条数（issue #19）。列表按倒计时排序分页，合计与总页数取真实总数；改后 `docker compose up -d web` 即生效（无需重建） |
| `WORKER_INTERVAL_MS` / `WORKER_ONCE` | `60000` / （空） | worker 调度间隔（生产 compose 设为每日） / 单轮模式 |
| `SOURCES_FIXTURE_BASE` | （空） | 设置后所有源适配器的列表页 URL 重写为 `<base>/<源ID>/<listFixturePath ?? list.html>`（列表为接口的源用 list.json；测试注入 fixture 源站，不设则抓取真实源站） |
| `ADMIN_TOKEN` | （空） | 管理后台 `/admin` 共享密钥（issue #12）。未配置时恒 401；配置后凭会话 Cookie 或 `?token=` 访问，详见「管理后台与健康告警」 |
| `ALERT_EMAIL` | （空） | worker 任务失败告警收件邮箱（issue #12）。未配置则不发送告警 |

本地验证抓取管线（fixture 注入）：

```bash
npm run fixtures   # 终端 1：本地 fixture 源站 http://127.0.0.1:4170
SOURCES_FIXTURE_BASE=http://127.0.0.1:4170 WORKER_ONCE=1 npm run worker   # 终端 2：单轮抓取
```

## 运行测试

```bash
npm run test:unit      # 单元层：规则表等纯函数，秒级，无需构建
npm run e2e            # 端到端层：next build + 进程内生产应用 + fixture 源站
npm test               # 等价命令：依次跑上面两层
```

一条命令完成：`next build` → node:test 启动**进程内生产模式应用**（随机端口）+
本地 fixture 源站，环境注入 SQLite 临时库与 stub LLM / stub 邮件，从 HTTP 层断言：

- 首页 200，含「主人翁」品牌与公示列表空态；
- fixture 源站按 `fixtures/<source>/` 目录服务快照（404 / 路径穿越防护）；
- stub LLM 返回固定结构化摘要、stub 邮件按 JSONL 捕获发出的邮件；
- **issue #3 全链路场景**（`tests/e2e/npc-pipeline.test.mjs`）：真实 worker 进程
  抓取 `fixtures/npc/` 快照 → 幂等入库 → 列表页倒计时 / 排序 / 状态徽标 →
  详情页字段与 AI 摘要展示（已截止条目保持占位）→ `/go/<id>` 302 至官方原文并
  计数 → 重复抓取条目数不变。
- **issue #4 摘要双路径场景**（`tests/e2e/summary-pipeline.test.mjs`）：stub LLM
  全部失败 → 每条目首调 + 3 次重试（调用日志精确计数）→ `failed_review` 转人工
  复核占位，且不再自动重试；追加新条目 → 成功路径 → 详情页五段式摘要 + 显著
  AI 标注 + 各段原文引用（一键跳官方原文）+ 占位消失。
- **issue #5 多源聚合场景**（`tests/e2e/sources-aggregation.test.mjs`）：在 npc
  之上新增司法部（`moj`）与生态环境部（`mee`，issue #14 起替代已下线的中国政府网
  「意见征集」栏目）两个源适配器（列表时间轴 / 正文句截止日期 / 两套详情模板等
  不同版式，证明适配器模式只需适配器文件 + 注册数组条目 + fixture 目录，核心代码
  零改动）：三源条目并存于聚合列表且按截止日期全局排序互不串扰、各源详情字段
  独立解析，同一原文 URL 出现在两个源列表时按原文 URL 唯一键去重只入库一条，
  重复抓取幂等。
- **issue #18 M2 扩源场景**（`tests/e2e/sources-expansion.test.mjs`）：交通运输部 /
  市场监管总局 / 工业和信息化部 / 教育部四源（`fixtures/e2e-sources/`）—— 覆盖
  「接口列表自带征集期」「隐藏字段毫秒时间戳截止日期」「静态列表状态标注」
  「标题取 title 属性」四类接入形态，并锁定状态推导次序（截止日期优先于源标注、
  解析不到时退回源标注）与栏目内非征求意见条目（答记者问 / 结果反馈）的过滤。
- **issue #7 邮件订阅与截止提醒场景**（`tests/e2e/deadline-reminders.test.mjs`）：
  `/subscribe` 表单校验 → double opt-in 确认邮件（outbox 断言）→ 未确认时
  触发提醒任务不发送 → 确认后触发：截止前 7 天 / 3 天各一封，内容含标题、
  剩余天数、截止日期、站内详情与官方原文链接（关键词命中标题 / 正文与领域
  命中标签均覆盖）→ 重跑不重发（`reminder_sends` 去重）→ 规则外条目不发 →
  一键退订立即生效，退订后新条目不再发送。
- **issue #6 全量 RSS feed 场景**（`tests/e2e/feed.test.mjs`）：worker 抓取
  `fixtures/e2e-feed/` 快照（含标题带 `&` / `<` 的条目）→ `/feed.xml`
  channel 结构（自动发现链接 + 页面可见入口）→ item 字段（发布日期倒序、
  详情页绝对链接、`guid isPermaLink=false`、RFC 822 pubDate、description
  含机关 / 截止日期 / 官方原文 / 显著标注的 AI 摘要片段）→ `&` / `<` 转义
  且全文档无裸 `&` → 补插 205 条合成条目后上限恰 200 条且顺序稳定。
- **issue #8 站内搜索场景**（`tests/e2e/search.test.mjs`）：worker 单轮抓取
  fixture → 索引同步（入库钩子 + 全量重建日志）→ 首页搜索框 → 标题关键词
  命中（「国家公园法」）→ 正文关键词命中（「监督检查」）→ AI 摘要文本命中
  → 结果项复用列表条目展示（状态 / 机关 / 截止日期 / 详情链接）→ 无关
  关键词空态 → `q` 为空重定向回列表 → 更新条目正文重新抓取后新关键词命中。
- **issue #10 版本链与条款对比场景**（`tests/e2e/version-diff.test.mjs`）：
  worker 抓取 `fixtures/e2e-versions/` 快照（同一法案两轮公示 + 无关单轮
  条目）→ 版本链自动关联（标题规范化 + 同机关）→ 第 2 轮详情页「对比上一版」
  入口（首轮 / 无关条目不显示）→ 对比视图轮次横幅（第 2 轮 + 上一轮日期）→
  新增 / 删除 / 修改三态高亮至少各一处（修改行含行内删除 / 新增片段）→
  无上一版条目的对比视图友好空态 → 重复抓取版本链不漂移。
- **issue #11 数据统计场景**（`tests/e2e/stats.test.mjs`）：真实 worker 抓取
  `fixtures/e2e-stats/` 三源快照（发布 / 截止日期全用令牌，公示期差值恒定）
  → 空库空态 → HTTP 调 `/go` 构造点击（今天 3 次 + mock.timers 回拨时钟
  昨天 3 次）→ 统计页概览 / 各部门公示量 / 最近 6 个月趋势矩阵 / 公示期
  长度分布四桶 / 点击 Top 榜回链详情页 / 按日期聚合逐项断言 → 重复抓取
  幂等不重算。
- **issue #12 管理后台与健康告警场景**（`tests/e2e/admin.test.mjs`）：仅复制
  npc fixture（moj / mee 404 天然构造部分源失败）→ 未带 token 401 引导页、
  错误 token 恒 401、登录 303 下发 HttpOnly Cookie 后可访问 → 看板展示各源
  最近成功时间与最近错误（HTTP 404）→ 失败源与摘要失败各触发一封告警邮件
  （stub outbox 断言收件人与错误摘要）→ 摘要失败条目进复核队列 → 重置重试
  （stub 恢复）自动补齐摘要 → 另一条人工编辑摘要保存 done → 手动补录条目
  走同一入库 / 摘要 / 索引管线（列表 / 检索 / 摘要断言 + 同 URL 幂等更新 +
  表单校验）→ 同日重复失败与任务级失败（非法 SEARCH_PROVIDER）均按
  （日 × 任务 × 源）去重 → 源停用后抓取跳过、看板即时反映、未授权 POST 401。

本地手动验证订阅提醒全链路：

```bash
npm run fixtures   # 终端 1：本地 fixture 源站 http://127.0.0.1:4170
APP_BASE_URL=http://localhost:3000 npm run dev                        # 终端 2：应用（/subscribe 订阅）
SOURCES_FIXTURE_BASE=http://127.0.0.1:4170 APP_BASE_URL=http://localhost:3000 WORKER_ONCE=1 npm run worker   # 终端 3：单轮抓取 + 提醒
```

## 邮件订阅与截止提醒（issue #7）

- **订阅**（`/subscribe`）：邮箱 + 关键词 / 领域规则，double opt-in —— 提交后
  先发确认邮件（`/subscribe/confirm?token=…`），点击确认订阅才生效；未确认的
  订阅绝不接收任何提醒。重复提交同邮箱只更新规则（不重复建行），并轮换确认
  token 使旧链接失效。
- **提醒**（worker 任务 `send-deadline-reminders`，每日调度）：计算截止日期
  恰为今天 + 7 / + 3 天的「征求意见中」条目，与每个已确认（未退订）订阅的
  规则匹配（关键词命中标题 / 正文，或领域命中条目标签），发送提醒邮件（标题、
  剩余天数、截止日期、站内详情链接、官方原文提意链接）。
- **去重**：`reminder_sends` 表以（条目 × 提醒档 d7/d3 × 订阅）为复合主键，
  同一条目同一档对同一订阅只发一次，任务重复运行不重发。
- **退订**：所有邮件底部带一键退订链接（`/unsubscribe?token=…`），点击立即
  生效，之后不再收到任何邮件。
- **合规**：仅存储订阅邮箱，不建用户账号；确认 / 提醒邮件均可一键退订。

数据库迁移在应用首连时自动应用（`drizzle/<driver>/`）；CI（GitHub Actions）运行
lint 与 e2e 两个 job，同样只依赖 npm。

## RSS Feed（issue #6）

- **端点**（`GET /feed.xml`）：RSS 2.0，每次请求实时读库生成（`force-dynamic`，
  不缓存），Content-Type `application/rss+xml; charset=utf-8`；XML 生成零依赖
  （转义 / 拼接逻辑见 `src/lib/feed.ts`）。
- **channel**：标题「主人翁 —— 政府公示信息聚合」、站点链接、描述、语言
  `zh-cn`、`lastBuildDate` 与 `atom:link rel="self"`。
- **item**：全量条目按**发布日期倒序**、上限 200 条；`link` 为站内详情页
  **绝对 URL**，`guid isPermaLink="false"` 为条目 ID，`pubDate` 为 RFC 822，
  `description` 含发布机关、截止日期、官方原文链接与 AI 摘要片段
  （仅摘要就绪时出现，并显著标注「AI 生成，仅供参考，以官方原文为准」；
  特殊字符按 XML 转义）。
- **站点地址**：feed 内绝对 URL 的基础由 `SITE_URL` 提供（默认
  `http://localhost:3000`，取值口径见 `src/lib/site-url.ts`，robots / sitemap /
  canonical 共用）。它与 `APP_BASE_URL`（订阅邮件内链接的基础地址，
  issue #7）**各司其职**：前者面向 RSS 阅读器与站外引用，后者面向邮件接收者，
  两者部署形态不同（如邮件走独立发信域名）时可分别配置；默认值一致，本地
  开发无需设置。

## 可发现性（robots / sitemap / 页面元数据）

- **`GET /robots.txt`**：允许收录全部公示内容；屏蔽 `/admin`（站长看板）、
  `/go/`（302 跳转端点，收录只会给爬虫制造重定向噪音）、`/api/`（提交端点），
  并声明 sitemap 绝对地址。
- **`GET /sitemap.xml`**：首页 + 统计页 + **全部条目详情页**（`lastModified`
  取抓取时间）；已截止条目同样收录 —— 它们是有效的公示存档页。不含 `/go/`。
  两者都实时读取库与 `SITE_URL`（`force-dynamic`），收录量级为每月数十条。
- **页面元数据**：根布局设 `metadataBase`（= `SITE_URL`）与站点级 Open Graph；
  条目详情页各自生成 `title`（公示标题）、`description`（状态 · 截止日期 ·
  机关 + 正文首段）、`canonical` 与 `og:url` —— 转发到社交平台或出现在搜索
  结果里时，展示的是这条公示本身而不是站点通用标题。
- **自定义 404**（`src/app/not-found.tsx`）：中文说明 + 站内检索 + 回列表入口
  （Next 默认 404 是英文且没有回站路径）。

## AI 摘要器（issue #4）

worker 注册表中的 `summarize-notices` 任务（`worker/jobs/summarize-notices.ts`）
对 `ai_summary_json` 为空、状态 `pending` 且**未截止**的条目调用 LLM 端口
（`LlmPort`，输入正文纯文本），输出五段式结构化摘要（这是什么 / 影响谁 /
关键条款 / 截止日期 / 如何提意见），每段附**原文引用片段**，连同 `summary_model`
落库（`notices.ai_summary_json`，形状见 `src/lib/summary-content.ts`）。

- **失败策略**：单条条目失败后重试 `SUMMARY_MAX_RETRIES` 次（默认 3，指数退避），
  仍失败置 `summary_status=failed_review` 转人工复核，worker 不再自动重试；
  已截止条目不生成摘要。
- **详情页**（`src/app/_lib/summary-view.tsx`）：`done` → 五段式摘要卡片 + 显著
  「AI 生成，仅供参考，以官方原文为准」标注 + 各段引用块（点击跳官方原文）；
  `pending` → 「摘要生成中」占位；`failed_review` → 「摘要生成中（待人工复核）」。
- **服务商切换**：`LLM_PROVIDER=stub`（默认，测试永远走 stub）或 `glm`（生产，
  智谱开放平台 OpenAI 兼容端点，`GLM_API_KEY` / `GLM_API_BASE` / `GLM_MODEL`
  配置，模型被要求只输出 JSON，解析做防御性校验）。本地不配 Key 联调 GLM 适配器
  的行为可参考 stub 的失败注入（`LLM_STUB_FAILURES`）。

## 站内全文检索（issue #8）

- **可插拔检索后端**（ADR-0001 第 2 条）：`src/lib/ports.ts` 的 `SearchPort`
  （`index` / `remove` / `search`），经 `createSearchPort()` 按 `SEARCH_PROVIDER`
  创建；worker 钩子与搜索页只依赖接口，不感知具体后端。
- **索引字段**：标题、AI 摘要各段 text 拼接（原文引用 quote **不入索引**）、
  正文纯文本（`src/lib/search/search-text.ts` 统一构建，本地与 Meilisearch
  两个后端共用同一文档形状）。
- **本地实现（默认 `SEARCH_PROVIDER=local`，开发 / 测试零外部依赖）**：
  SQLite 方言走迁移 0004 建立的 FTS5 虚表 `notices_fts`。unicode61 分词器对
  连续汉字只建一个长词、无法子串命中，故索引写入前在相邻汉字之间插空格、
  查询把中文片段还原为同规则短语 —— 短语相邻性等价原文本连续子串（中文按
  子串语义命中任意长关键词），英文 / 数字走前缀匹配；结果按 BM25 相关性排序，
  索引孤儿行与 `notices` 表联查兜底。PostgreSQL 方言不建本地索引结构，检索
  退化为对 `notices` 的 ILIKE（应用层按同一字段语义复核候选行）。
- **Meilisearch 适配器（`SEARCH_PROVIDER=meilisearch`，生产）**：原生 fetch
  直连 REST API（零新增依赖），首次使用自动建索引（`primaryKey=id`，重复
  写入幂等更新）并设置可搜索属性（title > summary > body）；异步索引任务
  轮询等待至成功，失败 / 超时抛出带详情的异常，由调用方决定降级。配置
  `MEILI_HOST` / `MEILI_API_KEY`（兼容 docker-compose 的 `MEILI_URL` /
  `MEILI_MASTER_KEY`）。开发机没有 Docker / Meilisearch，本适配器不做本地
  集成验证，生产部署阶段联调（ADR-0001 已知风险）。
- **索引同步（双层）**：抓取任务在每源入库 / 更新后、摘要任务在摘要落库后
  **即时同步受影响条目**（失败仅记日志降级，不打断主管线）；worker 注册表
  末位的 `reindex-notices` 任务每轮**全量重刷**兜底。一次性全量重建入口：
  `node scripts/reindex-search.mjs`（更换检索后端 / 手动修复索引用）。
- **搜索 UI**：列表页头部搜索框（GET 表单提交 `/search?q=…`，零客户端 JS）
  + `/search` 结果页；结果项复用列表条目展示（状态徽标 / 截止倒计时 /
  发布机关 / 发布与截止日期），按相关度排序；空结果给友好提示，`q` 为空
  重定向回列表页，检索后端故障渲染错误态而非 500。

## 领域分类浏览与筛选（issue #9）

- **领域标签体系**（`src/lib/categories.ts`，单一词表）：首批 10 个领域
  （立法与司法 / 经济与产业 / 科技与互联网 / 教育与科研 / 医疗卫生 /
  生态环境 / 交通运输 / 市场监管 / 社会保障 / 数据与网络安全），每个领域
  一组关键词，命中条目标题或正文即打上该领域标签；多领域同时命中则多标签，
  无任何命中则不打标签（不设「其他」兜底，未打标条目仍出现在未筛选列表、
  检索与 RSS 中）。词表刻意避开「司法部」「邮政编码」「科技与法制司」这类
  机关名 / 高频泛词（详见该文件模块注释），宁缺勿滥；词表避不开的机关名与
  专有名词由**排除语境**兜底（`KEYWORD_CONTEXT_EXCLUSIONS`：真实数据里
  「国家法律法规数据库」的「数据」、「工业和信息化部」的「信息化」都不算
  命中，裸词仍命中）。法案 / 条例草案按「草案」标记进「立法与司法」。
- **单一打标入口**：`upsertNotice` 在调用方未提供 `categoryTags` 时按关键词
  规则自动打标（更新路径同样按最新标题 / 正文重算）——抓取管线与后台手动
  补录（issue #12）共用该入口，任何写入方零改动即获得打标；适配器可经
  `NormalizedNotice.categoryTags` 直接给出权威领域（优先采用，关键词规则
  兜底）。订阅领域选项（issue #7 的 `CATEGORY_OPTIONS`）改为引用同一词表，
  条目标签与订阅领域永不漂移。
- **列表页筛选条**（首页，纯 URL 驱动、零客户端 JS）：
  - **领域标签云**：10 领域链接 + 「全部领域」，激活态高亮（`aria-current`），
    切换领域时保留机关 / 关键词筛选；
  - **发布机关下拉**：选项来自库内去重机关（`listNoticeAgencies`），精确
    匹配（「司法部」≠「司法部立法一局」）；
  - **关键词框**：标题 / 正文包含匹配（不区分大小写），与站内检索（FTS
    相关性排序）互不影响——筛选框在首页按倒计时顺序过滤，搜索页按相关度；
  - 三维度可任意组合且全部落在 querystring（`/?category=…&agency=…&q=…`），
    可直接分享；结果计数与当前筛选摘要随页展示；无结果渲染空态并提供
    「清除全部筛选」入口；未知领域参数不生效（避免任意串触发无效筛选）。
- **与倒计时排序叠加**：筛选只过滤行、不改变排序——过滤结果始终是未筛选
  列表（征求意见中在前、截止日期升序）的同序子序列。仓库层新增
  `listNoticesFiltered` / `listNoticeAgencies`（`src/db/repo/notices.ts`），
  排序表达式与 `listNotices` 共用同一常量；不改动既有查询函数语义。
- **单元**：`tests/unit/categories.test.mjs` —— 规则表逐条钉死：关键词命中标题 /
  正文、两种排除语境（专有名词「数据库」与机关名「工业和信息化部」）、无兜底标签、
  词表自洽（标签唯一、取值校验）。
- **E2E**：`tests/e2e/category-filter.test.mjs` —— 三源 fixture 入库后逐条
  断言标签（覆盖关键词命中标题与命中正文两类、排除语境两条），领域 / 机关 /
  关键词 / 组合过滤、无结果空态与排序子序列断言。

## 发布机关：归一与多发布机关匹配（issue #21）

`agency` 是**忠实于源站的显示值**（适配器取标题前缀或栏目常量），所以同一机关会有多种
写法、联合发文是一个复合串。源扩到 8 个后生产库 150 条出现了 **18 种机关写法**，其中
三类是真问题（都是实测出来的，不是假设）：

- **同一机关两种写法**：交通运输部栏目里「中国民用航空局关于《民用航空空中交通管理
  规则》…」与「中国民航局关于《运输机场运营许可规定》…」——同一主办机关的两条公告；
- **联合发文无法按参与机关检索**：「司法部、中国人民银行、金融监管总局、中国证监会、
  国家外汇局」——选「司法部」看不到它，选「中国人民银行」连选项都没有；
- **同一栏目两种机关名**：生态环境部栏目的 xxgk 模板带「发布机关」字段（生态环境部
  办公厅，29 条），hdjl 模板没有该字段、取适配器常量（生态环境部，1 条）。

做法（`src/lib/agencies.ts` + `notices.agency_keys`，迁移 0008）：

- `canonicalAgency`：**别名表**把已知的同一机关写法收敛到规范名（目前只有实测到的那
  一对，不做猜测性归一）；
- `splitAgencies` / `leadAgencyOf`：复合串按顿号 / 空白拆成参与机关集合与牵头机关；
- `agencyKeysOf`：参与集合的**竖线包夹串**（`|司法部|中国人民银行|`）入库到
  `agency_keys`，让「按任一参与机关筛选」用一条 `LIKE '%|X|%'` 精确表达
  （与 `category_tags_json` 的筛选同一套路数）。竖线包夹同时避免子串误命中
  —— 查「司法部」不会命中「司法部办公厅」。
- **`agency` 列本身不变**：详情页、feed、列表展示的仍是源站原样的机关文本，
  联合发文照样完整显示五个机关；变的只是「可被哪些机关筛到」与统计口径。
- **筛选**（`listNoticesFiltered`）：`agency = X` **或** `agency_keys LIKE '%|X|%'`
  —— 旧行（迁移后尚未重抓，`agency_keys` 为空）仍按原值精确匹配，向后兼容。
- **机关下拉**（`listNoticeAgencies`）：列的是**参与机关**，不再是复合串 —— 联合发文的
  每个参与机关都能单独选中（下拉里从 18 个选项变成 7 个可选项 + 更短的文本）。
- **统计口径**（`getAgencyTotals` / `getAgencyMonthlyCounts`）：按**牵头机关**归并，
  联合发文归到第一个机关名下，**每条只计一次**（各部门合计 = 条目总数，不重复计数）。
  刻意**不做**内设机构向部本级的折叠：「市场监管总局特种设备局」「生态环境部办公厅」
  是源站自己署的发文机关，是真实信息。

- **单元**：`tests/unit/agencies.test.mjs` —— 别名收敛、复合串拆分（顿号 / 空白 / 混用 /
  去重保序）、牵头机关、竖线包夹串（含「司法部」不命中「司法部办公厅」的反向断言）。
- **E2E**：`tests/e2e/category-filter.test.mjs` —— 任一参与机关（中国人民银行 /
  金融监管总局 / 中国证监会 / 国家外汇局）都能筛到联合发文、复合串原值仍精确命中、
  生态环境部栏目三套模板机关名统一；`tests/e2e/stats.test.mjs` —— 各部门公示量按
  牵头机关归并且合计等于条目总数。

## 首页分页与真实合计（issue #19）

源扩到 7 个后库内超过 50 条，暴露了列表页的两个缺陷：**硬编码 50 条上限且无翻页**
（其余条目从首页不可达），以及「共 N 条」显示的是**本页条数**而非全量（假合计）。

- **合计取真实总数**：仓库层新增 `countNoticesFiltered`（`src/db/repo/notices.ts`），
  与 `listNoticesFiltered` 共用同一组 `filterConditions` —— 两处 WHERE 必须一致，
  否则合计与实际能翻到的行数会打架。`count(*)` 在双方言下返回类型不同
  （PostgreSQL 的 bigint 走字符串），统一 `Number()`。
- **分页**：`limit` + `offset`（排序由 `AGGREGATION_ORDER` 决定，是确定性的，
  故 offset 分页不重复不漏行）；每页条数由 `LIST_PAGE_SIZE` 控制（默认 50）。
  页码参数非法 / 越界一律夹到有效范围（`?page=999` 落到末页而不是空页）。
- **链接**：翻页与筛选都是普通链接，保留全部筛选条件；**切换筛选时页码归 1**
  （筛选链接不写 `page`）；单页结果不渲染分页控件。
- **E2E**：`tests/e2e/pagination.test.mjs` —— 用 `LIST_PAGE_SIZE=3` 把三源 fixture
  的 9 条切成 3 页：合计是真实总数、逐页翻完等于全量且无重复、顺序与未筛选的
  倒计时顺序一致、筛选后合计与总页数按筛选结果算、越界与非法页码夹到有效范围。

## 版本历史与条款对比（issue #10）

- **版本链**（`notices` 自引用两列，迁移 0005 双方言）：`version_of` 指向
  **上一轮**条目 id，`version_seq` 为轮次序号（1 = 首轮公示）；首版 /
  未关联条目 `version_of` 为空。选直接前驱指向而非链根指向：对比上一版
  只需一次主键查询。
- **关联规则**：标题规范化键（去空白与标点、取书名号内法案主体、去含轮次词
  的括号段与征求意见套语，见 `src/lib/versions.ts`）+ **同一发布机关**。
  抓取管线幂等入库（`upsertNotice`）时自动触发，任何写入方无需感知。
- **整链重算**（`src/db/repo/versions.ts`）：每有条目入库 / 更新，同分组的
  全部条目按发布日期升序重新编号（缺失沉底、同日按 id 兜底）—— 任意顺序
  入库（先抓到第二轮、后抓到首轮）都收敛到正确链序，重算幂等（值不变不写
  库），标题 / 机关变化离开旧分组时旧链自动缝合。
- **对比视图**（`/notices/[id]/diff`）：详情页对存在上一版的条目展示轮次
  提示与「对比上一版」入口；对比页显著提示「这是第 N 轮征求意见稿，与上一轮
  （日期）对比」，正文按条款（章 / 条 / 款项归属 / 段落）切分后呈现
  新增 / 删除 / 修改三态高亮，修改行再标行内删除 / 新增片段
  （`src/lib/notice-diff.ts`：零依赖自实现 —— LCS 锚定 + 同编号 / 相似度
  配对 + 字符级片段，无分词器依赖）。无上一版的条目访问对比视图给出友好
  空态；差异为自动比对，页面注明以官方原文为准。
- **检索一致性**：版本链不改变索引字段（标题 / 摘要 / 正文），issue #8 的
  索引同步钩子无需调整；两条目成为版本链不影响其各自的检索命中。
## 数据统计页（issue #11）

- **页面**（`GET /stats`，列表页头部「数据统计」入口）：服务端实时渲染
  （`force-dynamic`，零客户端 JS）。
- **部门公示量趋势**：各发布机关公示量（`GROUP BY agency`）+ 最近 6 个
  日历月趋势矩阵（机关 × 月，含行小计与全部机关合计行）。月份取自 ISO
  日期字符串截取 `substr(published_at, 1, 7)`（SQLite / PostgreSQL 交集
  子集，不用方言专属日期函数），窗口裁剪与补零在应用层完成。
- **公示期长度分布**：截止日期 - 发布日期的天数按 ≤7 / 8-15 / 16-30 / >30
  天分桶（条形图纯 CSS）。双方言交集内无可移植的天数差 SQL 函数，天数差
  在应用层按日历日计算；缺失发布或截止日期的条目不参与分布。
- **出站提意点击聚合（北极星指标）**：概览累计点击 + 条目点击 Top 10
  （每项链接回站内详情页）+ 按日期聚合。点击写入两条腿：既有
  `notices.outbound_clicks` 总计数（issue #5）+ `outbound_click_daily`
  按（条目 × 本地日历日）聚合表（迁移 0005，复合主键 upsert 幂等），
  按日期聚合即对该表 `GROUP BY click_date` 求和。
- **隐私边界**：点击数据只有条目 ID 与日期两个维度，纯计数聚合，
  无 IP、无 Cookie、无账号（`/go` 端点保持不变）。

## 管理后台与健康告警（issue #12）

### 访问保护（`/admin`）

- 共享密钥 = 环境变量 `ADMIN_TOKEN`，**未配置时所有 `/admin*` 请求一律 401**
  配置指引页。配置后两种放行方式：登录表单（`POST /admin/login`，令牌正确则
  303 回 `/admin` 并下发 HttpOnly + SameSite=Lax 会话 Cookie，7 天有效）或直接
  在 URL 带 `?token=<ADMIN_TOKEN>`（脚本 / curl 友好）；`POST /admin/logout` 退出。
- 令牌比较为常量时间（双方各做 SHA-256 后 `timingSafeEqual`）；后台为自包含
  HTML + 表单 POST（零客户端 JS、零认证依赖），写操作未授权一律 401。

### 三个功能

- **源健康看板**：每个抓取源一行 —— 健康 / 异常、启用 / 停用、最近成功抓取
  时间、最近错误信息与时间（成功不清空最近错误，便于排查曾停摆的源）。
  启停开关（`POST /admin/sources`）即时生效：抓取任务整轮跳过停用源。
- **摘要人工复核队列**：`summary_status='failed_review'` 的条目两种处置 ——
  「重置并重试」清空摘要列并置回 pending（摘要任务下一轮自动重新生成）；或
  直接编辑五段式摘要文本保存为 done（`summary_model=manual`，详情页立即展示
  并同步检索索引）。
- **手动补录**：结构化表单（标题 / 发布机关 / 原文 URL / 发布与截止日期 /
  正文纯文本）→ 与爬虫完全相同的管线：以原文 URL 为唯一键幂等 upsert
  （条目 id 同为 URL 的 SHA-256 前缀）、状态推导一致、入库即同步检索索引、
  摘要列保持 pending 由摘要任务自动生成 AI 摘要。条目登记在专用源
  「manual（人工补录）」下，看板可见。

### 失败邮件告警

- 三类失败发告警到 `ALERT_EMAIL`（未配置则整体跳过）：源抓取失败（按源）、
  条目摘要重试耗尽转人工复核（按条目所属源）、任务级整任务抛错（源显示 `—`）。
  邮件含任务名、源、发生时间与错误摘要（600 字截断）。
- **去重落表**：`alert_sends` 按（本地日历日 × 任务名 × 源）复合主键 ——
  同一天同一源同一任务类型只发一封，worker 重启后依然有效；邮件发送失败不落
  去重标记，下一轮任务再失败时重试发送。

## 接入的源（issue #14 三源 + issue #18 扩至七源，均对着活站校准）

| 源 ID | 栏目与真实列表地址 | 传输处置 | 列表 / 详情结构要点 |
| --- | --- | --- | --- |
| `npc` | 全国人大网「法律草案征求意见」<br>`http://www.npc.gov.cn/flcaw/flca-list?flag=0&type=0&page=1&per_page=100` | **只能用 http**：`www.npc.gov.cn` 的 HTTPS 在 TLS 握手阶段即被拒（`sslv3 alert handshake failure`；换 TLS1.2 / 降 SECLEVEL / `--insecure` 均无效，**不是证书链问题**）。风险：明文传输；缓解：只读官方公开信息、不带凭据、不下载附件 | 列表与正文都是 JSON 接口（页面为前端渲染）；正文取自 `/flcaw/flca/<id>/info/`，用户可见链接仍是 `userIndex.html?lid=<id>`；接口不提供发布机关与附件 |
| `moj` | 司法部「立法意见征集」<br>`https://www.moj.gov.cn/pub/sfbgw/lfyjzj/lflfyjzj/` | **WAF cookie 挑战**：首包 302 + `Set-Cookie`（CT6T/CT6TS）且 Location 指回同一地址，需带 cookie 重放一次才 200（抓取层 `fetch.cookieChallenge`，仅本源生效） | 列表 `ul.newsMsgList_zzy > li`（标题被截断，完整标题取自详情 `h1`）；发布日期在 `.sT`；截止日期只在正文句「征求意见时间为 X 至 Y」；机关取自标题前缀（详情页无发布机关行） |
| `mee` | 生态环境部「意见征集」<br>`https://www.mee.gov.cn/hdjl/yjzj/` | 无特殊要求（爬虫 UA 直接 200） | 列表 `li > a + span.date`，链接混用栏目内相对路径与 `../../xxgk2018/…` 跨目录相对路径；详情两套模板（栏目内页 `h2.neiright_Title`，政府信息公开页 `h1` + 「发布机关」字段）；截止日期在正文句；附件是正文内的相对 `.pdf` 链接 |
| `mot` | 交通运输部「意见征集」<br>`https://www.mot.gov.cn/hudong/yijianzhengji/index.html` | 无特殊要求（静态 HTML） | 列表 `ul.news-list li.news-item > a.news-link`，状态标注 `[进行中]/[已结束]` 是真实列表判据（状态位为空的是混入的答记者问 / 反馈情况，被过滤）；条目链接跨域混排（民航局 / 铁路局站点，其详情页不属本源模板 → 保留列表层字段）；截止日期在详情正文「意见反馈截止日期为…」 |
| `samr` | 市场监管总局「征集调查」<br>`https://www.samr.gov.cn/hd/zjdc/` | 无特殊要求；列表是站内 TRS jpaas 接口<br>`/api-gateway/jpaas-publish-server/front/page/build/unit`（GET + queryData，返回 `{data:{html}}` 片段） | 列表行自带**征集期**（`2026-09-17至2026-10-17`）与状态列 —— 起作发布日期、止作截止日期（多数详情正文没有截止句）；正文 `.Three_xilan_07`；附件不在正文里，在「附件下载」清单 `ul.contentLeft0102box`（该 class 出现两次，前一个是空占位） |
| `miit` | 工业和信息化部「意见征集」<br>`https://www.miit.gov.cn/gzcy/yjzj/` | 无特殊要求；列表同上 TRS jpaas 接口（参数不同） | 截止日期在列表隐藏字段 `span.endtime` 的**毫秒时间戳**（与详情正文「请于…前反馈意见」互为印证）；正文 `#con_con`；附件是正文内的 pdf 链接；标题多为「关于公开征求…的公示」，机关兜底为部本级 |
| `moe` | 教育部「征求意见」<br>`http://www.moe.gov.cn/jyb_xwfb/s248/` | 无特殊要求（静态 HTML） | 列表 `#list li`，**标题必须取 `title` 属性**（联合发布条目的链接文本被截断）；状态标注在标题前缀；正文 `.moe-detail-box .TRS_Editor`（页面尾部的 `#detail-editor` 只是「责任编辑」一行，不是正文）。**该栏目自 2024-02 起未再更新**（历史归档，52 条全部已截止），接入理由见适配器文件头 |
| `ndrc` | 国家发展改革委「意见征求」<br>`https://www.ndrc.gov.cn/hdjl/yjzq/` | 无特殊要求；**正文需链式跳转**（见下方「链式跳转」） | 列表 `ul.u-list > li > a[title] + span`，标题带 `【进行中】` 前缀 / `[已结束]` 后缀（两种都剥离）；条目链接是数据服务域名下的前端渲染页 `sa.html#/<shortKey>`；正文与截止日期（「此次公开征求意见的时间为 X 至 Y」）都在 `getArticleDetail` 接口返回的 `articleContent` 里，附件是正文 HTML 内的绝对链接；接口返回的标题含 `<BR>` 换行标签，入库前剥掉 |

第三源为何不是中国政府网：原 `govcn`（中国政府网「政策 → 意见征集」）实测**已下线**
（`/zhengce/yjzj/**` 全 404；政策频道仅剩最新政策 / 国务院公报 / 政策解读 / 图解政策，
政策文件库路径对爬虫一律 403）。本产品承诺「聚合征求意见稿 + 截止提醒」，故换用真实
在运营、可抓取且含截止日期的部委征求意见栏目（issue #14）。

PRD M2 的「部委直爬源扩展至 8 个」**已达成**（上表 8 个源）。国家网信办首页无
「征求意见」栏目入口、常见候选路径全 404，未接入（依据记在 `src/sources/registry.ts`
的注册表注释里）。

**状态推导次序**（issue #18）：截止日期是事实、优先；解析不到时采用源自身标注
（`NormalizedNotice.status`，来自列表的状态列 / 标题标注）；都取不到才兜底「征求意见中」。
否则跨域条目与详情缺截止句的条目会被误判为进行中。

### 链式跳转（issue #20）

有些源的正文地址要一跳一跳才拿得到。国家发展改革委实测：列表条目是前端渲染页
`sa.html#/<shortKey>` → `access-url` 接口返回文章页地址 → 文章页只是空壳、
正文在 `getArticleDetail` 接口里。

- **契约**：`SourceAdapter.resolveDetailUrl(body, pageUrl)` 返回**下一跳地址**，
  返回 null 表示「当前 body 即详情内容」。`detailContentUrl` 给首跳（同步）。
  跳数上限 `MAX_DETAIL_HOPS = 4`，超限报错降级 —— 适配器若因页面改版始终返回
  下一跳，不会把整轮抓取拖死。
- **每一跳的请求都由抓取层发出**（不是适配器自己 fetch）：源级传输处置
  （`fetch.cookieChallenge`）、UA、超时、fixture 地址重写集中在抓取层一处；
  适配器自己发请求还会让 E2E 打到真实站点（ADR-0001）。适配器只做
  「从这一跳的 body / 地址推出下一跳地址」这件纯计算的事。
- **下一跳地址相对当前跳地址推导**（不硬编码域名）：生产落在真实站点、
  E2E 里落在 fixture 目录内，同一份代码两条路都通。E2E 里按条目分目录
  （`ndrc/i1/…`）—— fixture 源站按路径映射、不认查询串，而真实站点所有条目
  共用同一路径、只靠 `?shortKey=` 区分。
- **失败降级**：链断掉（如 access-url 响应缺 articleId）只记日志并保留列表层数据
  （条目照常入库、状态退回源标注），不丢条目、不中断整源 —— E2E 有专门锚点。

抓取礼貌性：详情请求之间固定间隔 400ms（`worker/jobs/crawl-notices.ts` 的
`DETAIL_FETCH_INTERVAL_MS`），避免政府站点 WAF 限流封 IP。

## 如何添加 fixture 源

见 `fixtures/README.md`。要点：

1. `fixtures/<source>/` 放入列表页 / 详情页 HTML 快照（`<source>` 即源 ID）；
2. 在 `src/sources/registry.ts` 的 `sourceAdapters` 数组登记适配器；
3. 在 `tests/e2e/` 为该源新增端到端场景，经 `SOURCES_FIXTURE_BASE` 把抓取指向
   fixture 源站。

## 扩展点约定（并行切片必须遵守）

新增能力一律通过各自模块内的**注册表 / 工厂**接入，不在核心代码硬编码：

| 扩展点 | 位置 | 接入方式 |
| --- | --- | --- |
| 源适配器 | `src/sources/registry.ts` | 适配器加入 `sourceAdapters` 数组 |
| worker 任务 | `worker/registry.ts` | 任务加入 `jobs` 数组 |
| LLM 提供商 | `src/lib/ports.ts` 的 `createLlmPort()` | 新分支返回适配器（环境变量切换） |
| 邮件提供商 | `src/lib/ports.ts` 的 `createMailerPort()` | 同上 |
| 检索后端 | `src/lib/ports.ts` 的 `createSearchPort()` | 新分支返回适配器（`SEARCH_PROVIDER=local \| meilisearch`） |

代码约定：`src/lib`、`src/db`、`worker` 内的相对导入使用显式 `.ts` 扩展名
（这些文件也会被 Node 24 类型剥离直接运行）；页面文件用 `@/` 别名。

## 数据库与迁移

- schema 双方言镜像：`src/db/schema/sqlite.ts` 与 `src/db/schema/postgres.ts`
  （列名与语义必须一致，修改需同步两文件）；
- 迁移按方言分别生成并提交：

```bash
npm run db:generate        # SQLite   → drizzle/sqlite/
npm run db:generate:pg     # PostgreSQL → drizzle/pg/
npm run db:migrate         # 对当前 DB_DRIVER 的库应用迁移
```

## docker-compose（生产对齐）

`docker-compose.yml` 编排 web / worker / PostgreSQL / Meilisearch 四服务，与 PRD
部署方案一致。**注意：开发机没有 Docker，该文件在开发机不可运行**，仅供生产部署
对齐（ADR-0001）；本地与 CI 的验收标准是 `npm run e2e` 全绿 + compose 文件与服务
清单一致。相关 Dockerfile（`Dockerfile.web` / `Dockerfile.worker`）同样未在本地
实际构建过，部署时按环境微调。
