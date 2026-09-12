import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * SQLite schema（开发 / 测试方言，ADR-0001）。
 *
 * 方言交集约定：
 * - 只使用 TEXT / INTEGER 列，不用任何 PG 专属类型；
 * - JSON（领域标签、AI 摘要、调度配置等）一律存 TEXT 列，由应用层序列化；
 * - 时间戳存 ISO 8601 字符串。
 *
 * PostgreSQL 镜像 schema 见 ./postgres.ts，两者列名与语义必须保持一致。
 */

export const sources = sqliteTable('sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  adapterType: text('adapter_type').notNull(),
  /** JSON 存 TEXT：调度配置（如 { "cron": "0 6 * * *" }） */
  scheduleConfigJson: text('schedule_config_json').notNull().default('{}'),
  /** 0 = 不健康 / 1 = 健康（双方言交集内没有 boolean，用 INTEGER 表达） */
  healthy: integer('healthy').notNull().default(1),
  lastSuccessAt: text('last_success_at'),
});

export const notices = sqliteTable('notices', {
  id: text('id').primaryKey(),
  sourceId: text('source_id')
    .notNull()
    .references(() => sources.id),
  title: text('title').notNull(),
  /** 发布机关 */
  agency: text('agency').notNull(),
  /** 官方原文 URL，唯一键防重复入库 */
  url: text('url').notNull().unique(),
  publishedAt: text('published_at'),
  /** 截止日期，ISO 8601 */
  deadlineAt: text('deadline_at'),
  /** 征求意见中 open / 已截止 closed / 已出结果 resulted */
  status: text('status').notNull().default('open'),
  /** JSON 存 TEXT：领域标签数组 */
  categoryTagsJson: text('category_tags_json').notNull().default('[]'),
  /** 正文纯文本 */
  bodyText: text('body_text'),
  /** JSON 存 TEXT：附件清单数组（NoticeAttachment[] = [{ name, url }]） */
  attachmentsJson: text('attachments_json').notNull().default('[]'),
  /** JSON 存 TEXT：结构化 AI 摘要（StructuredSummary） */
  aiSummaryJson: text('ai_summary_json'),
  /** 摘要模型名与版本 */
  summaryModel: text('summary_model'),
  /** 抓取时间，ISO 8601 */
  fetchedAt: text('fetched_at').notNull(),
  /** 出站提意点击数（北极星指标） */
  outboundClicks: integer('outbound_clicks').notNull().default(0),
});
