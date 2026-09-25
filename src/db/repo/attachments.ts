import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb } from '../client.ts';
import { noticeAttachments, notices } from '../schema/sqlite.ts';
import {
  deriveNoticeGenre,
  genreDecisionWins,
  type GenreDecision,
  type GenreEvidenceKind,
} from '../../lib/notice-genre.ts';
import type {
  AttachmentExtractStatus,
  AttachmentKind,
  NoticeAttachment,
  NoticeAttachmentRecord,
} from '../types.ts';

/**
 * 附件抽取的仓库层（issue #57）—— `notice_attachments` 的读写都集中在这里。
 *
 * 抓取管线（repo/notices.ts）不碰本表：附件清单每轮被 `attachments_json` 整体覆盖，
 * 而抽取状态必须跨轮存活（否则每天重下一遍同样的 60 页 PDF）。因此本层的入口是
 * 「把这一轮看到的清单同步进来」（`syncAttachmentManifest`），按 (notice_id, url)
 * 幂等对齐，而不是由抓取侧直接写状态。
 */


/**
 * 用附件正文重算一次体裁（issue #76），只有正文级证据能把它升级成"修正案"。
 *
 * 为什么必须由抽取任务来做、不能在抓取入库时一次判完：最强的那条证据是正文里的对照措辞
 * （"某条修改为…""删去第几条""增加一条"），而正文要到本任务解析完才存在。生产实测：
 * 标题含"修正/修订"的 22 条里 19 条撞得到这条措辞；另有标题不写"修正"、正文却是修订文本的。
 *
 * 返回 null = 没写库（条目不存在，或新证据不比已存的强）。后者是刻意的：
 * 弱证据覆盖强证据会让下一轮抓取把刚升级的判定降回去，两个 job 来回拉扯，
 * 读者看到的摘要形态跟着抖。
 */
export async function refreshNoticeGenreFromAttachments(
  noticeId: string,
): Promise<GenreDecision | null> {
  const db = await getDb();
  const heads = await db
    .select({
      title: notices.title,
      genreEvidence: notices.genreEvidence,
    })
    .from(notices)
    .where(eq(notices.id, noticeId))
    .limit(1);
  if (heads.length === 0) return null;
  const files = await db
    .select({ name: noticeAttachments.name, extractedText: noticeAttachments.extractedText })
    .from(noticeAttachments)
    .where(eq(noticeAttachments.noticeId, noticeId));
  const decision = deriveNoticeGenre({
    title: heads[0].title,
    attachmentNames: files.map((file) => file.name ?? ''),
    attachmentText: files.map((file) => file.extractedText ?? '').join(' '),
  });
  if (!genreDecisionWins(decision.evidence, heads[0].genreEvidence as GenreEvidenceKind | null)) {
    return null;
  }
  await db
    .update(notices)
    .set({ genre: decision.genre, genreBasis: decision.basis, genreEvidence: decision.evidence })
    .where(eq(notices.id, noticeId));
  return decision;
}
/** 一行抽取结果的写入载荷（`markAttachmentResult` 的入参）。 */
export interface AttachmentResultPatch {
  status: AttachmentExtractStatus;
  kind?: AttachmentKind | null;
  bytes?: number | null;
  contentHash?: string | null;
  charCount?: number | null;
  extractedText?: string | null;
  error?: string | null;
  /** 真的发了请求才置时间戳；被熔断跳过时留 null，下轮仍可重试 */
  fetchedAt?: Date | null;
}

/** 工作队列的准入窗口（由任务层传入，仓库层只负责比较）。 */
export interface AttachmentEligibility {
  now: Date;
  /** `blocked` 的退避：距上次请求超过这个天数才再试（miit 那批每周探一次就够） */
  blockedRetryAfterDays: number;
  /** `error` 的重试上限：超过就停在 error 不再消耗请求 */
  maxAttempts: number;
  /** `ok` 的刷新周期：官方可能在同一 URL 上换稿，太久没取要重取一次 */
  refreshAfterDays: number;
}

/** 待抽取扫描结果：一条公示 + 它本轮清单里的附件。 */
export interface NoticeAttachmentManifest {
  id: string;
  url: string;
  title: string;
  sourceId: string;
  attachments: NoticeAttachment[];
}

function iso(date: Date): string {
  return date.toISOString();
}

function daysAgo(from: Date, days: number): string {
  return iso(new Date(from.getTime() - days * 86_400_000));
}

function toRecord(row: typeof noticeAttachments.$inferSelect): NoticeAttachmentRecord {
  return {
    noticeId: row.noticeId,
    url: row.url,
    name: row.name,
    status: row.status as AttachmentExtractStatus,
    kind: row.kind as AttachmentKind | null,
    bytes: row.bytes,
    contentHash: row.contentHash,
    charCount: row.charCount,
    extractedText: row.extractedText,
    error: row.error,
    fedToSummary: row.fedToSummary === 1,
    attemptCount: row.attemptCount,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    lastFetchAt: row.lastFetchAt,
  };
}

/**
 * 扫描带附件清单的未截止条目（按抓取时间升序，与摘要队列同一公平顺序）。
 * `sourceIds` 用于按源灰度；为空表示不限源。
 */
export async function listNoticesForAttachmentExtraction(options: {
  limit: number;
  sourceIds?: string[];
}): Promise<NoticeAttachmentManifest[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: notices.id,
      url: notices.url,
      title: notices.title,
      sourceId: notices.sourceId,
      attachmentsJson: notices.attachmentsJson,
    })
    .from(notices)
    .where(
      options.sourceIds && options.sourceIds.length > 0
        ? and(ne(notices.status, 'closed'), inArray(notices.sourceId, options.sourceIds))
        : ne(notices.status, 'closed'),
    )
    .orderBy(notices.fetchedAt, notices.id)
    .limit(options.limit);

  return rows.map((row) => ({
    id: row.id,
    url: row.url,
    title: row.title,
    sourceId: row.sourceId,
    attachments: parseAttachmentManifest(row.attachmentsJson),
  }));
}

/** 清单列是 JSON-in-TEXT，坏项静默丢掉（与 repo/notices.ts 的 parseAttachments 同一口径）。 */
function parseAttachmentManifest(raw: string): NoticeAttachment[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is NoticeAttachment =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { url?: unknown }).url === 'string' &&
        typeof (item as { name?: unknown }).name === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * 把本轮看到的附件清单同步进表：新行置 pending，已有行只刷新 name / last_seen_at，
 * 清单里已经消失的 URL 直接删行（官方撤下附件时不留孤儿状态）。
 *
 * 刻意不覆盖 status：那是上一轮的结论，只有 `url` 变了才算新文件。
 */
export async function syncAttachmentManifest(input: {
  noticeId: string;
  attachments: NoticeAttachment[];
  now: Date;
}): Promise<void> {
  const db = await getDb();
  const seenAt = iso(input.now);
  const urls: string[] = [];

  for (const attachment of input.attachments) {
    const url = attachment.url.trim();
    if (url === '' || urls.includes(url)) continue;
    urls.push(url);
    await db
      .insert(noticeAttachments)
      .values({
        noticeId: input.noticeId,
        url,
        name: attachment.name,
        status: 'pending',
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      })
      .onConflictDoUpdate({
        target: [noticeAttachments.noticeId, noticeAttachments.url],
        set: { name: attachment.name, lastSeenAt: seenAt },
      });
  }

  // 本轮没再见到的 URL 删掉；一条公示的清单为空时整表清空该条目
  const stale = await db
    .select({ url: noticeAttachments.url })
    .from(noticeAttachments)
    .where(eq(noticeAttachments.noticeId, input.noticeId));
  const doomed = stale.map((row) => row.url).filter((url) => !urls.includes(url));
  if (doomed.length > 0) {
    await db
      .delete(noticeAttachments)
      .where(
        and(
          eq(noticeAttachments.noticeId, input.noticeId),
          inArray(noticeAttachments.url, doomed),
        ),
      );
  }
}

/**
 * 一条公示本轮可处理的附件行（准入判断见 `AttachmentEligibility`）：
 * pending 一律可处理；`blocked` 按退避窗口重试；`error` 按次数上限重试；
 * `ok` 超过刷新周期才重取；其余终态（扫描件 / 空白表 / 非文件 / 超限）不再消耗请求。
 */
export async function listEligibleAttachments(
  noticeId: string,
  eligibility: AttachmentEligibility,
): Promise<NoticeAttachmentRecord[]> {
  const db = await getDb();
  const { now, blockedRetryAfterDays, maxAttempts, refreshAfterDays } = eligibility;
  const rows = await db
    .select()
    .from(noticeAttachments)
    .where(eq(noticeAttachments.noticeId, noticeId));

  return rows.map(toRecord).filter((row) => {
    switch (row.status) {
      case 'pending':
        return true;
      case 'blocked':
        return row.lastFetchAt === null || row.lastFetchAt < daysAgo(now, blockedRetryAfterDays);
      case 'error':
        return row.attemptCount < maxAttempts;
      case 'ok':
        return row.lastFetchAt === null || row.lastFetchAt < daysAgo(now, refreshAfterDays);
      default:
        return false;
    }
  });
}

/** 写入一个文件的处理结论。`attempt_count` 只在真的发过请求时递增。 */
export async function markAttachmentResult(
  noticeId: string,
  url: string,
  patch: AttachmentResultPatch,
): Promise<void> {
  const db = await getDb();
  const fetchedAt = patch.fetchedAt ?? null;
  await db
    .update(noticeAttachments)
    .set({
      status: patch.status,
      kind: patch.kind ?? null,
      bytes: patch.bytes ?? null,
      contentHash: patch.contentHash ?? null,
      charCount: patch.charCount ?? null,
      extractedText: patch.extractedText ?? null,
      error: patch.error ?? null,
      // 没发请求的分支（熔断跳过）不能把上次的时间戳擦掉，否则 blocked 的退避窗口会被重置
      ...(fetchedAt !== null ? { lastFetchAt: iso(fetchedAt), attemptCount: sql`${noticeAttachments.attemptCount} + 1` } : {}),
    })
    .where(and(eq(noticeAttachments.noticeId, noticeId), eq(noticeAttachments.url, url)));
}

/**
 * 一条公示的全部附件行（**不做**准入过滤）。
 *
 * 与 `listEligibleAttachments` 分开是必要的：那个函数按「本轮还要不要为它花请求」筛过，
 * 所以终态行（扫描件 / 空白表 / 不支持的容器）在它的答案里根本不出现。而详情页的
 * 「为什么读不到」（issue #57 的三分支文案）与审计脚本恰恰只关心那些终态。
 */
export async function listNoticeAttachments(noticeId: string): Promise<NoticeAttachmentRecord[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(noticeAttachments)
    .where(eq(noticeAttachments.noticeId, noticeId));
  return rows.map(toRecord);
}

/**
 * 摘要任务用的输入：已抽出条文的行，按字数降序取前 `limit` 个。
 * 字数多更可能是草案本文 —— 打分在选择阶段（任务层）已经做过一次，这里刻意不再引入第二套排序。
 */
export async function listAttachmentsForSummary(
  noticeId: string,
  options: { minChars: number; limit: number },
): Promise<{ name: string; url: string; text: string }[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(noticeAttachments)
    .where(
      and(eq(noticeAttachments.noticeId, noticeId), eq(noticeAttachments.status, 'ok')),
    );
  return rows
    .map(toRecord)
    .filter((row) => (row.charCount ?? 0) >= options.minChars && (row.extractedText ?? '') !== '')
    .sort((a, b) => (b.charCount ?? 0) - (a.charCount ?? 0))
    .slice(0, options.limit)
    .map((row) => ({
      name: row.name ?? row.url,
      url: row.url,
      text: row.extractedText as string,
    }));
}

/** 标记「本轮摘要真的用了这些附件」，详情页据此决定「条文在哪」的文案分支。 */
export async function markAttachmentsFedToSummary(
  noticeId: string,
  urls: string[],
): Promise<void> {
  const db = await getDb();
  if (urls.length === 0) return;
  await db
    .update(noticeAttachments)
    .set({ fedToSummary: 1 })
    .where(
      and(
        eq(noticeAttachments.noticeId, noticeId),
        inArray(noticeAttachments.url, urls),
      ),
    );
}

/** 详情页「条文在哪」需要的读侧报告（issue #57 的三分支文案）。 */
export interface AttachmentExtractReport {
  /** 清单里的附件数 */
  total: number;
  /** 已喂给摘要的附件（名称 + 链接） */
  fed: { name: string; url: string }[];
  /** 已喂给摘要的条文合计字数（页面用它说「本站读到了多少字」） */
  fedChars: number;
  /** 已抽到条文的附件份数与字数（抽到了但本轮没喂给摘要 —— 影子档的正常形态） */
  okFiles: number;
  okChars: number;
  /** 各失败状态计数，用于「为什么读不到」的诚实说明 */
  failures: Partial<Record<AttachmentExtractStatus, number>>;
}

export async function getNoticeAttachmentExtractReport(
  noticeId: string,
): Promise<AttachmentExtractReport> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(noticeAttachments)
    .where(eq(noticeAttachments.noticeId, noticeId));
  const records = rows.map(toRecord);
  const failures: Partial<Record<AttachmentExtractStatus, number>> = {};
  for (const row of records) {
    if (row.status === 'ok' || row.status === 'pending') continue;
    failures[row.status] = (failures[row.status] ?? 0) + 1;
  }
  const fedRows = records.filter((row) => row.fedToSummary);
  const okRows = records.filter((row) => row.status === 'ok');
  const charsOf = (list: typeof records): number =>
    list.reduce((sum, row) => sum + (row.charCount ?? 0), 0);
  return {
    total: records.length,
    fed: fedRows.map((row) => ({ name: row.name ?? row.url, url: row.url })),
    fedChars: charsOf(fedRows),
    okFiles: okRows.length,
    okChars: charsOf(okRows),
    failures,
  };
}
