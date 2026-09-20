-- issue #8：站内全文检索（PostgreSQL 方言占位迁移）。
-- 检索索引的物理结构（FTS5 虚表）是 SQLite 专属特性，仅 SQLite 方言需要；
-- PostgreSQL 方言下 LocalSearch 退化为对 notices（标题 / 正文 / AI 摘要 JSON）
-- 的 ILIKE 查询（收录量级为每月数十条，无需额外索引结构），本方言无任何 DDL。
-- 本文件仅为保持双方言迁移编号一致（约定见 CLAUDE.md 与 ADR-0001）。
SELECT 1;
