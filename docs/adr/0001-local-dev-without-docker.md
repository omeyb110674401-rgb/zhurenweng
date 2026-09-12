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
