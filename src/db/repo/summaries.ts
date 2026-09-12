import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { getDb } from '../client.ts';
import { notices } from '../schema/sqlite.ts';
import type { SummaryStatus } from '../../lib/summary-content.ts';

/**
 * AI 摘要的仓库层（issue #4）—— notices 表摘要列（ai_summary_json /
 * summary_model / summary_status）的读写都集中在此，抓取管线的
 * repo/notices.ts upsert 不触碰这三列。
 */

/** 待摘要扫描结果：摘要任务生成 LLM 输入所需的最小字段集 */
export interface PendingSummaryTarget {
  id: string;
  title: string;
  url: string;
  bodyText: string | null;
  /** 所属源 ID（issue #12 告警去重键的一部分） */
  sourceId: string;
}

/**
 * 扫描待摘要条目：摘要 JSON 为空、状态为 pending、且公示未截止。
 * 已截止条目不再生成摘要（issue #4）；failed_review 由人工复核处理，
 * worker 不再自动重试。
 */
export async function listNoticesForSummary(limit = 50): Promise<PendingSummaryTarget[]> {
  const db = await getDb();
  return db
    .select({
      id: notices.id,
      title: notices.title,
      url: notices.url,
      bodyText: notices.bodyText,
      sourceId: notices.sourceId,
    })
    .from(notices)
    .where(
      and(
        isNull(notices.aiSummaryJson),
        eq(notices.summaryStatus, 'pending'),
        ne(notices.status, 'closed'),
      ),
    )
    .orderBy(asc(notices.fetchedAt), asc(notices.id))
    .limit(limit);
}

/**
 * 人工复核队列（issue #12）：全部 summary_status='failed_review' 的条目，
 * 按抓取时间升序（最早失败的最先复核）。
 */
export async function listNoticesForReview(limit = 50): Promise<PendingSummaryTarget[]> {
  const db = await getDb();
  return db
    .select({
      id: notices.id,
      title: notices.title,
      url: notices.url,
      bodyText: notices.bodyText,
      sourceId: notices.sourceId,
    })
    .from(notices)
    .where(eq(notices.summaryStatus, 'failed_review'))
    .orderBy(asc(notices.fetchedAt), asc(notices.id))
    .limit(limit);
}

/**
 * 复核队列「重置重试」（issue #12）：清空摘要列并置回 pending，让摘要任务
 * 在下一轮自动重新生成。仅对 failed_review 状态的条目生效，条目不存在或
 * 不在待复核状态返回 false。
 */
export async function resetNoticeSummaryForRetry(id: string): Promise<boolean> {
  const db = await getDb();
  const existing = await db
    .select({ id: notices.id, status: notices.summaryStatus })
    .from(notices)
    .where(eq(notices.id, id))
    .limit(1);
  if (existing.length === 0 || existing[0].status !== 'failed_review') {
    return false;
  }
  await db
    .update(notices)
    .set({ aiSummaryJson: null, summaryModel: null, summaryStatus: 'pending' })
    .where(eq(notices.id, id));
  return true;
}

/** 详情页 / 复核队列所需的摘要列信息；条目不存在返回 null。 */
export interface NoticeSummaryInfo {
  summaryStatus: SummaryStatus;
  aiSummaryJson: string | null;
  summaryModel: string | null;
}

export async function getNoticeSummary(id: string): Promise<NoticeSummaryInfo | null> {
  const db = await getDb();
  const rows = await db
    .select({
      summaryStatus: notices.summaryStatus,
      aiSummaryJson: notices.aiSummaryJson,
      summaryModel: notices.summaryModel,
    })
    .from(notices)
    .where(eq(notices.id, id))
    .limit(1);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    summaryStatus: row.summaryStatus as SummaryStatus,
    aiSummaryJson: row.aiSummaryJson,
    summaryModel: row.summaryModel,
  };
}

/** 摘要落库：写入五段式 JSON（含原文引用）与模型名，状态置为 done。 */
export async function saveNoticeSummary(input: {
  id: string;
  summaryJson: string;
  summaryModel: string;
}): Promise<void> {
  const db = await getDb();
  await db
    .update(notices)
    .set({
      aiSummaryJson: input.summaryJson,
      summaryModel: input.summaryModel,
      summaryStatus: 'done',
    })
    .where(eq(notices.id, input.id));
}

/** 重试耗尽后转人工复核：状态置为 failed_review，worker 不再自动重试。 */
export async function markNoticeSummaryForReview(id: string): Promise<void> {
  const db = await getDb();
  await db
    .update(notices)
    .set({ summaryStatus: 'failed_review' })
    .where(eq(notices.id, id));
}
