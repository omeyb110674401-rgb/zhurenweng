import { desc } from 'drizzle-orm';
import { getDb } from '../client.ts';
import { notices } from '../schema/sqlite.ts';
import { safeParseJson, safeParseJsonArray, type NoticeRecord, type NoticeStatus } from '../types.ts';

export interface ListNoticesOptions {
  limit?: number;
}

/**
 * 按截止日期降序（最紧急在前）、抓取时间降序列出公示条目。
 * 空库返回空数组，首页据此渲染空态。
 */
export async function listNotices(options: ListNoticesOptions = {}): Promise<NoticeRecord[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(notices)
    .orderBy(desc(notices.deadlineAt), desc(notices.fetchedAt))
    .limit(options.limit ?? 50);
  return rows.map(toNoticeRecord);
}

function toNoticeRecord(row: typeof notices.$inferSelect): NoticeRecord {
  return {
    id: row.id,
    sourceId: row.sourceId,
    title: row.title,
    agency: row.agency,
    url: row.url,
    publishedAt: row.publishedAt,
    deadlineAt: row.deadlineAt,
    status: row.status as NoticeStatus,
    categoryTags: safeParseJsonArray(row.categoryTagsJson),
    bodyText: row.bodyText,
    aiSummary: safeParseJson(row.aiSummaryJson),
    summaryModel: row.summaryModel,
    fetchedAt: row.fetchedAt,
    outboundClicks: row.outboundClicks,
  };
}
