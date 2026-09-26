# ADR-0001：开发与测试环境脱离 Docker 运行

日期：2026-09-12　状态：已接受　决策人：开发总监（经用户授权调度）

## 背景

开发主机（Windows 10 + Git Bash）**没有 Docker，也没有本地 PostgreSQL/psql**，只有 Node 24 + npm。PRD（docs/prd/v1.md）要求 Docker Compose 编排 web / worker / PostgreSQL / Meilisearch，且测试缝要求端到端测试随时可运行——若测试依赖 Docker，本机无法验证任何切片。

## 决策

1. **数据库**：数据访问层使用支持双方言的 ORM（如 Drizzle）；**开发与测试使用 SQLite 文件库，生产使用 PostgreSQL**。为避免方言陷阱，SQL 只使用两者交集子集：JSON 存 TEXT 列（应用层序列化）、不使用 PG 专属类型、迁移按方言分别生成。
2. **检索**：定义可插拔 `SearchPort` 接口。生产实现为 Meilisearch 适配器；**开发/测试提供同接口的本地实现（SQLite FTS5 或等价物）**，保证"入库→索引→搜索命中"的端到端场景在本机可测。
3. **部署工件**：仍然交付 `docker-compose.yml`（web / worker / PostgreSQL / Meilisearch），用于生产部署对齐；它在开发机上不可运行，这一点在 README 注明。
4. **端到端测试**：`npm test` / `npm run e2e` 一条命令跑通全部场景（本地 fixture 源站 + stub LLM + stub 邮件 + 应用进程内启动 + SQLite），**不依赖任何外部服务**。CI 同样只依赖 npm。
5. 邮件、LLM 在测试中永远走 stub；真实 SMTP / 已备案 LLM API 仅通过生产环境变量接入。

## 后果

- 任何切片的验收标准中"docker compose up"改为"`npm run e2e` 全绿 + docker-compose.yml 存在且与服务清单一致"。
- 方言交集可能牺牲个别 PG 特性（如 JSONB 索引）；数据量小（国家级公示每月数十条），可接受。
- Meilisearch 适配器的集成验证推迟到生产部署（issue #13）阶段，属已知风险。

## 补充：PostgreSQL 那一半**没有被测过**（2026-09-26，issue #83）

上面那句"迁移按方言分别生成"留下了一个**看起来是绿的**边界，这轮把它写下来，免得下一个人
以为 PG 侧也被门守着：

- **事实**：10 个仓库模块（versions / summaries / subscriptions / stats / sources / reminders /
  notifications / alerts / notices / attachments）一律 `import { … } from '../schema/sqlite.ts'`，
  与当前驱动无关；`src/db/client.ts` 对 PG 驱动返回的是 `return db as unknown as AppDatabase;`
  —— 一次**没有任何运行时校验**的类型断言。
- **因此**：① 所有仓库查询的类型检查是针对 SQLite schema 做的，PG 列类型（int8 / timestamptz …）
  从未参与编译；② 本地 e2e 全绿**不能**说明生产那条路径也对 —— 这正是 0012–0014
  迁移在生产被**静默跳过**（本地全新库永远全跑、看不出跳过）那一类事故的土壤。
- **被守住的与没被守住的**：迁移文件本身有守卫（`tests/e2e/migrations-integrity.test.mjs`：
  两方言序号一致、同名迁移列集合一致、`when` 严格递增，以及"存量库向后迁移"的真实两阶段回放）；
  **没被守住的是驱动行为与类型转换**，它只在生产真跑时暴露，目前靠线上抽查兜着。
- **本轮的处置（最小动作）**：把这条边界写进 ADR —— 让它不再看起来是绿的。**没有**为它补测试，
  因为一条能真正覆盖它的测试需要本地 PostgreSQL，而那正是本 ADR 第 1 条拒绝的前提。
- **要动它的触发条件**（任一成立再考虑）：① PG 侧再出一次"只在生产成立"的缺陷；
  ② 数据量或并发上到需要 PG 专属特性（JSONB 索引、`ON CONFLICT` 的 PG 语义差异等）；
  ③ 换机器时能跑起一个 Postgres 容器。届时的方向是给仓库层加双方言类型（或至少给
  "只在 PG 上成立"的分支加形状守卫）—— 先例是 `periodDaysExpr`：它是全项目**唯一**被允许
  按驱动分支的地方，理由与边界写在那段注释里。
