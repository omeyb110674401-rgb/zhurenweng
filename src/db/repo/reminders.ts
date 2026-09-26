import { and, eq, isNotNull } from 'drizzle-orm';
import { getDb } from '../client.ts';
import { notices, reminderSends } from '../schema/sqlite.ts';
import { toNoticeRecordWithoutContent } from './notice-record.ts';
import type { NoticeRecord, ReminderStage } from '../types.ts';

/**
 * 截止提醒仓库（issue #7）：提醒候选条目查询 + 发送去重标记。
 *
 * 去重键 = 条目 × 提醒档（d7 / d3）× 订阅，即 reminder_sends 的复合主键，
 * 重复触发任务不会重发。数据量为国家级公示的量级（每月数十条），候选条目
 * 直接全量取出后在应用层按剩余天数筛选，保证双方言 SQL 交集。
 *
 * 行→记录的映射走 ./notice-record.ts 的**不带内容**那一支（issue #83 F 项）：
 * 本文件原先自己抄了一份映射表，加一列要记得改三处。
 */
const toNoticeRecord = toNoticeRecordWithoutContent;

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
