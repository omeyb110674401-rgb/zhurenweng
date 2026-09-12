import { and, eq, isNotNull } from 'drizzle-orm';
import { getDb } from '../client.ts';
import { notices, reminderSends } from '../schema/sqlite.ts';
import type { NoticeRecord, NoticeStatus, ReminderStage } from '../types.ts';

/**
 * 截止提醒仓库（issue #7）：提醒候选条目查询 + 发送去重标记。
 *
 * 去重键 = 条目 × 提醒档（d7 / d3）× 订阅，即 reminder_sends 的复合主键，
 * 重复触发任务不会重发。数据量为国家级公示的量级（每月数十条），候选条目
 * 直接全量取出后在应用层按剩余天数筛选，保证双方言 SQL 交集。
 */

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
    categoryTags: safeParseArray(row.categoryTagsJson),
    bodyText: row.bodyText,
    attachments: [],
    aiSummary: null,
    summaryModel: row.summaryModel,
    fetchedAt: row.fetchedAt,
    outboundClicks: row.outboundClicks,
  };
}

function safeParseArray(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

/** 提醒候选条目：征求意见中且带截止日期。 */
export async function listOpenNoticesWithDeadline(): Promise<NoticeRecord[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(notices)
    .where(and(eq(notices.status, 'open'), isNotNull(notices.deadlineAt)));
  return rows.map(toNoticeRecord);
}

/** 该条目 × 提醒档 × 订阅是否已发送过提醒。 */
export async function hasReminderSend(
  noticeId: string,
  subscriptionId: string,
  stage: ReminderStage,
): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .select({ noticeId: reminderSends.noticeId })
    .from(reminderSends)
    .where(
      and(
        eq(reminderSends.noticeId, noticeId),
        eq(reminderSends.reminderStage, stage),
        eq(reminderSends.subscriptionId, subscriptionId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** 记录发送标记（发送成功后调用）；复合主键冲突时静默忽略，保证幂等。 */
export async function recordReminderSend(
  noticeId: string,
  subscriptionId: string,
  stage: ReminderStage,
  sentAt: string,
): Promise<void> {
  const db = await getDb();
  await db
    .insert(reminderSends)
    .values({ noticeId, subscriptionId, reminderStage: stage, sentAt })
    .onConflictDoNothing();
}
