import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
  /** JSON 存 TEXT：结构化 AI 摘要（五段式带原文引用，形状见 src/lib/summary-content.ts 的 QuotedSummary） */
  aiSummaryJson: text('ai_summary_json'),
  /** 摘要模型名与版本 */
  summaryModel: text('summary_model'),
  /**
   * 摘要状态（issue #4）：pending 待生成 / done 已生成 / failed_review 重试耗尽待人工复核。
   * 抓取 upsert 不触碰本列（属摘要管线，与 ai_summary_json / summary_model 一致）。
   */
  summaryStatus: text('summary_status').notNull().default('pending'),
  /** 抓取时间，ISO 8601 */
  fetchedAt: text('fetched_at').notNull(),
  /** 出站提意点击数（北极星指标） */
  outboundClicks: integer('outbound_clicks').notNull().default(0),
  /**
   * 版本链（issue #10）：本条目的上一轮版本条目 id（notices 自引用）。
   * 由抓取入库时的版本关联逻辑自动维护（src/db/repo/versions.ts，
   * 匹配规则 = 标题规范化 + 同一发布机关）；首版 / 未关联条目为 NULL。
   * 不建自引用外键约束：关联完全由应用层维护，且保持双方言迁移简单。
   */
  versionOf: text('version_of'),
  /** 版本轮次序号（1 = 首轮公示），随 versionOf 一并由版本关联逻辑维护；未关联为 NULL */
  versionSeq: integer('version_seq'),
});

/**
 * 邮件订阅（issue #7，double opt-in）。
 *
 * - 邮箱唯一：重复订阅同邮箱更新规则而非重复建行；
 * - confirmed = 0（待确认）/ 1（已生效）：未确认的订阅绝不接收任何提醒；
 * - 确认 / 退订各持一个独立随机 token（出现在邮件链接里）；
 * - unsubscribed_at 非空即已退订，之后不再收到任何邮件（行保留，便于审计与防重发）。
 */
export const subscriptions = sqliteTable('subscriptions', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  /** JSON 存 TEXT：关键词规则数组（命中标题或正文） */
  keywordsJson: text('keywords_json').notNull().default('[]'),
  /** JSON 存 TEXT：领域规则数组（命中条目领域标签） */
  categoriesJson: text('categories_json').notNull().default('[]'),
  /** 0 = 待确认 / 1 = 已确认（双方言交集内没有 boolean，用 INTEGER 表达） */
  confirmed: integer('confirmed').notNull().default(0),
  /** 订阅确认令牌（确认邮件链接） */
  confirmToken: text('confirm_token').notNull().unique(),
  /** 一键退订令牌（所有邮件底部链接） */
  unsubscribeToken: text('unsubscribe_token').notNull().unique(),
  /** 确认时间，ISO 8601；未确认为 null */
  confirmedAt: text('confirmed_at'),
  /** 退订时间，ISO 8601；未退订为 null */
  unsubscribedAt: text('unsubscribed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * 提醒发送去重记录（issue #7）：同一条目 × 同一提醒档（7 天 / 3 天）×
 * 同一订阅只发一次。复合主键天然幂等，重复触发任务不会重发。
 */
export const reminderSends = sqliteTable(
  'reminder_sends',
  {
    noticeId: text('notice_id')
      .notNull()
      .references(() => notices.id),
    subscriptionId: text('subscription_id')
      .notNull()
      .references(() => subscriptions.id),
    /** 提醒档：d7 = 截止前 7 天 / d3 = 截止前 3 天 */
    reminderStage: text('reminder_stage').notNull(),
    /** 发送时间，ISO 8601 */
    sentAt: text('sent_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.noticeId, table.reminderStage, table.subscriptionId] }),
  ],
);
