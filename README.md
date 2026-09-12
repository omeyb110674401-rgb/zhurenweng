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
- **测试**：node:test + 原生 fetch 的端到端管线缝（本地 fixture 源站 + stub LLM / stub 邮件），
  `npm run e2e` 一条命令跑通，**不依赖 Docker 与任何外部服务**

## 目录结构

```
src/app/        Next.js 应用（列表 / 详情 /go/<id> 出站跳转）
src/db/         数据层：schema（sqlite / postgres 镜像）、client、repo
src/lib/        端口接口（ports.ts）、日期工具（dates.ts）与适配器（stubs）
src/sources/    源适配器注册表 + adapters/（数据接入唯一扩展点）
worker/         worker 进程：registry.ts（任务注册表）+ index.ts（主循环）+ jobs/（抓取等任务）
fixtures/       各源页面快照，fixtures/<source>/*.html
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
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` | （空） | `MAILER_PROVIDER=smtp` 时的 SMTP 接入配置（`SMTP_SECURE=1` 走 TLS 直连，端口 465 默认 TLS） |
| `APP_BASE_URL` | `http://localhost:3000` | 邮件内确认 / 退订 / 详情链接的站点基础地址 |
| `SITE_URL` | `http://localhost:3000` | RSS feed 内站点链接 / 条目链接的对外绝对地址（issue #6，与 `APP_BASE_URL` 各司其职，见「RSS Feed」） |
| `FIXTURES_DIR` / `FIXTURE_SERVER_PORT` | `fixtures/` / `4170` | fixture 源站目录与端口 |
| `WORKER_INTERVAL_MS` / `WORKER_ONCE` | `60000` / （空） | worker 调度间隔（生产 compose 设为每日） / 单轮模式 |
| `SOURCES_FIXTURE_BASE` | （空） | 设置后所有源适配器的列表页 URL 重写为 `<base>/<源ID>/list.html`（测试注入 fixture 源站；不设则抓取真实源站） |

本地验证抓取管线（fixture 注入）：

```bash
npm run fixtures   # 终端 1：本地 fixture 源站 http://127.0.0.1:4170
SOURCES_FIXTURE_BASE=http://127.0.0.1:4170 WORKER_ONCE=1 npm run worker   # 终端 2：单轮抓取
```

## 运行端到端测试

```bash
npm run e2e            # 等价命令：npm test
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
  `http://localhost:3000`）。它与 `APP_BASE_URL`（订阅邮件内链接的基础地址，
  issue #7）**各司其职**：前者面向 RSS 阅读器与站外引用，后者面向邮件接收者，
  两者部署形态不同（如邮件走独立发信域名）时可分别配置；默认值一致，本地
  开发无需设置。

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
| 检索后端 | `src/lib/ports.ts` 的 `SearchPort` | 检索切片实现 Meilisearch / 本地实现 |

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
