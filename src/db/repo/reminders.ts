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

/**
 * 批量记录发送标记（issue #84）：一封合并提醒里列了 N 条，就在**发信成功之后**
 * 一次性写 N 行。分成 N 次写也能work，但那时"写到一半失败"会留下一半已标记、
 * 一半没标记的状态，而这一批本来是同生共死的（同一封信送出去的）。
 *
 * 冲突静默忽略，与单条版同一个理由：复合主键天然幂等，重复触发不会重发。
 */
export async function recordReminderSends(
  entries: readonly { noticeId: string; stage: ReminderStage }[],
  subscriptionId: string,
  sentAt: string,
): Promise<void> {
  if (entries.length === 0) return;
  const db = await getDb();
  await db
    .insert(reminderSends)
    .values(
      entries.map((entry) => ({
        noticeId: entry.noticeId,
        subscriptionId,
        reminderStage: entry.stage,
        sentAt,
      })),
    )
    .onConflictDoNothing();
}
