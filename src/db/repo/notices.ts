import { asc, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../client.ts';
import { notices } from '../schema/sqlite.ts';
import {
  safeParseJson,
  safeParseJsonArray,
  type NoticeAttachment,
  type NoticeRecord,
  type NoticeStatus,
} from '../types.ts';

export interface ListNoticesOptions {
  limit?: number;
}

/**
 * 抓取管线写入的条目形状（幂等 upsert 的输入）。
 * id 由调用方按原文 URL 确定性生成（sha256 前缀），重复抓取命中同一行。
 */
export interface UpsertNoticeInput {
  id: string;
  sourceId: string;
  title: string;
  agency: string;
  url: string;
  publishedAt: string | null;
  deadlineAt: string | null;
  status: NoticeStatus;
  categoryTags: string[];
  bodyText: string | null;
  attachments: NoticeAttachment[];
  fetchedAt: string;
}

/**
 * 聚合列表排序（issue #3）：
 * 1. 征求意见中在前，已截止 / 已出结果沉底；
 * 2. 组内按截止日期升序（即将截止在前），无截止日期的排最后；
 * 3. 以抓取时间降序兜底。
 * 双方言交集下 NULL 排序位置不同（SQLite 在前、PostgreSQL 在后），
 * 故用显式 CASE 归一化。
 */
export async function listNotices(options: ListNoticesOptions = {}): Promise<NoticeRecord[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(notices)
    .orderBy(
      sql`case when ${notices.status} = 'open' then 0 else 1 end`,
      sql`case when ${notices.deadlineAt} is null then 1 else 0 end`,
      asc(notices.deadlineAt),
      desc(notices.fetchedAt),
    )
    .limit(options.limit ?? 50);
  return rows.map(toNoticeRecord);
}

/** 按主键取单条；不存在返回 null（详情页与 /go 端点使用）。 */
export async function getNoticeById(id: string): Promise<NoticeRecord | null> {
  const db = await getDb();
  const rows = await db.select().from(notices).where(eq(notices.id, id)).limit(1);
  return rows.length > 0 ? toNoticeRecord(rows[0]) : null;
}

/**
 * 幂等入库：以原文 URL 为唯一键。已存在则更新内容字段（标题、机关、日期、
 * 状态、正文、附件、抓取时间），不触碰 id / 点击计数 / AI 摘要（属摘要管线）。
 * 返回 'inserted' | 'updated' 供抓取日志统计。
 */
export async function upsertNotice(input: UpsertNoticeInput): Promise<'inserted' | 'updated'> {
  const db = await getDb();
  const existing = await db
    .select({ id: notices.id })
    .from(notices)
    .where(eq(notices.url, input.url))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(notices)
      .set({
        title: input.title,
        agency: input.agency,
        publishedAt: input.publishedAt,
        deadlineAt: input.deadlineAt,
        status: input.status,
        categoryTagsJson: JSON.stringify(input.categoryTags),
        bodyText: input.bodyText,
        attachmentsJson: JSON.stringify(input.attachments),
        fetchedAt: input.fetchedAt,
      })
      .where(eq(notices.url, input.url));
    return 'updated';
  }

  await db.insert(notices).values({
    id: input.id,
    sourceId: input.sourceId,
    title: input.title,
    agency: input.agency,
    url: input.url,
    publishedAt: input.publishedAt,
    deadlineAt: input.deadlineAt,
    status: input.status,
    categoryTagsJson: JSON.stringify(input.categoryTags),
    bodyText: input.bodyText,
    attachmentsJson: JSON.stringify(input.attachments),
    fetchedAt: input.fetchedAt,
  });
  return 'inserted';
}

/**
 * 出站提意点击 +1（北极星指标）。只记录条目与时间，不记录任何个人身份。
 * 条目不存在返回 null。
 */
export async function recordOutboundClick(id: string): Promise<number | null> {
  const db = await getDb();
  const rows = await db
    .update(notices)
    .set({ outboundClicks: sql`${notices.outboundClicks} + 1` })
    .where(eq(notices.id, id))
    .returning({ outboundClicks: notices.outboundClicks });
  return rows.length > 0 ? rows[0].outboundClicks : null;
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
    attachments: parseAttachments(row.attachmentsJson),
    aiSummary: safeParseJson(row.aiSummaryJson),
    summaryModel: row.summaryModel,
    fetchedAt: row.fetchedAt,
    outboundClicks: row.outboundClicks,
  };
}

function parseAttachments(text: string): NoticeAttachment[] {
  const parsed = safeParseJson(text);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => {
      if (typeof item !== 'object' || item === null) return null;
      const record = item as Record<string, unknown>;
      if (typeof record.name !== 'string' || typeof record.url !== 'string') return null;
      return { name: record.name, url: record.url };
    })
    .filter((item): item is NoticeAttachment => item !== null);
}
