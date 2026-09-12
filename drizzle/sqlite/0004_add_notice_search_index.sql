-- issue #8：站内全文检索（SQLite 方言）。
-- FTS5 虚表是应用层管理的独立索引结构（SearchPort 本地实现写入 / 查询）：
-- - notice_id 关联 notices.id（UNINDEXED：不参与全文匹配）；
-- - title / summary / body 分别存标题、AI 摘要各段文本拼接（原文引用不入索引）、
--   正文纯文本；写入前由应用层做 CJK 字间空格变换（见 src/lib/search/search-text.ts），
--   使 unicode61 分词器按单字建词，短语查询即等价中文子串检索。
-- 注意：FTS5 为 SQLite 专属特性，drizzle-kit 不建模虚表，本迁移为手写 SQL
-- （PostgreSQL 方言镜像见 ../pg/0004_add_notice_search_index.sql，该方言
-- 的检索走 ILIKE 退化，无需物理索引表）。
CREATE VIRTUAL TABLE `notices_fts` USING fts5(
	`notice_id` UNINDEXED,
	`title`,
	`summary`,
	`body`
);
