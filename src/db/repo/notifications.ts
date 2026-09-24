import { and, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import { getDb } from '../client.ts';
import { noticeNotifications, notices } from '../schema/sqlite.ts';
import type { NoticeRecord, NoticeStatus } from '../types.ts';

/**
 * 新公示通知仓库（issue #60 第 3 刀）：候选条目查询 + 每人每条的去重标记。
 *
 * 「新」的判据是 `notices.first_seen_at`（建行时写入、更新永不覆盖），**不是** `fetched_at`：
 * 后者每天被抓取覆盖，用它当判据会把三个月前的条目天天重新通知一遍。
 * 存量行 `first_seen_at` 为 NULL 且被 `isNotNull` 挡在门外 —— 这是"刚确认订阅的老邮箱
 * 不会收到库里全部历史公示"这条保证的落点。
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
    firstSeenAt: row.firstSeenAt,
    outboundClicks: row.outboundClicks,
    versionOf: row.versionOf,
    versionSeq: row.versionSeq,
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

/**
 * 首次收录时间在 `sinceIso` 之后的条目（按首次收录升序：汇总里旧的在前，读起来是时间线）。
 * 不限制状态 —— 一条公示可能入库当天就标注了已截止，那也该让订阅者知道它存在过。
 */
export async function listNoticesFirstSeenSince(sinceIso: string): Promise<NoticeRecord[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(notices)
    .where(and(isNotNull(notices.firstSeenAt), gte(notices.firstSeenAt, sinceIso)))
    .orderBy(notices.firstSeenAt);
  return rows.map(toNoticeRecord);
}

/**
 * 这批条目里已经通知过的 (条目 × 订阅) 对，一次查完。
 *
 * 为什么不按订阅各查一次：那会变成"订阅者数 × 每轮一次查询"，
 * 而这轮真正要的判断只是"这个对有没有出现过"。
 */
export async function listNotifiedPairs(
  noticeIds: string[],
): Promise<Set<string>> {
  if (noticeIds.length === 0) return new Set();
  const db = await getDb();
  const rows = await db
    .select({
      noticeId: noticeNotifications.noticeId,
      subscriptionId: noticeNotifications.subscriptionId,
    })
    .from(noticeNotifications)
    .where(inArray(noticeNotifications.noticeId, noticeIds));
  return new Set(rows.map((row) => `${row.noticeId}\u0000${row.subscriptionId}`));
}

/**
 * 记录"这些条目已随一封汇总邮件通知过这个订阅"。
 *
 * **必须在邮件真的发出去之后**调用：先记后发等于把"没送到"说成"已通知"，
 * 那条公示就永远不会再出现在这个人的收件箱里（去重键已经写了）。
 * 单行冲突（同一条被并发写过）不影响正确性，故用 insert...onConflictDoNothing。
 */
export async function recordNoticeNotifications(input: {
  subscriptionId: string;
  noticeIds: string[];
  sentAt: string;
}): Promise<void> {
  if (input.noticeIds.length === 0) return;
  const db = await getDb();
  await db
    .insert(noticeNotifications)
    .values(
      input.noticeIds.map((noticeId) => ({
        noticeId,
        subscriptionId: input.subscriptionId,
        sentAt: input.sentAt,
      })),
    )
    .onConflictDoNothing({
      target: [noticeNotifications.noticeId, noticeNotifications.subscriptionId],
    });
}

/** 去重表规模（只读：后台看板与审计脚本用来判断"这表在不在无界增长"）。 */
export async function countNoticeNotifications(): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({ noticeId: noticeNotifications.noticeId })
    .from(noticeNotifications);
  return rows.length;
}
