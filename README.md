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
| `LLM_PROVIDER` | `stub` | `stub`（固定摘要）/ `glm`（AI 摘要切片交付） |
| `MAILER_PROVIDER` | `stub` | `stub`（捕获邮件）/ `smtp`（邮件切片交付） |
| `MAILER_OUTBOX_FILE` | （空） | stub 邮件追加写入的 JSONL 文件，供跨进程断言 |
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
  详情页字段与「摘要生成中」占位 → `/go/<id>` 302 至官方原文并计数 →
  重复抓取条目数不变。
- **issue #5 多源聚合场景**（`tests/e2e/sources-aggregation.test.mjs`）：在 npc
  之上新增司法部（`moj`）与中国政府网（`govcn`）两个源适配器（各自卡片+表格、
  纯表格等不同版式，证明适配器模式只需适配器文件 + 注册数组条目 + fixture 目录，
  核心代码零改动）：三源条目并存于聚合列表且按截止日期全局排序互不串扰、
  各源详情字段独立解析，同一原文 URL 出现在两个源列表时按原文 URL 唯一键
  去重只入库一条，重复抓取幂等。

数据库迁移在应用首连时自动应用（`drizzle/<driver>/`）；CI（GitHub Actions）运行
lint 与 e2e 两个 job，同样只依赖 npm。

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
