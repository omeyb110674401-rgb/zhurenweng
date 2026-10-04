import { parseImpactReviews } from '../../lib/impact-review.ts';
import { notices } from '../schema/sqlite.ts';
import { safeParseJson, safeParseJsonArray, type NoticeAttachment, type NoticeRecord } from '../types.ts';

/**
 * `notices` 行 → `NoticeRecord` 的**唯一**映射（issue #83 F 项）。
 *
 * 此前这份映射在三个仓库模块里各有一份：`notices.ts` / `notifications.ts` / `reminders.ts`。
 * 三份的差异只有一处、而且是刻意的：后两者读的是"发邮件要用的那几列"，`attachments` 给空数组、
 * `aiSummary` 给 null（邮件通知里不挂附件清单、也不引用摘要）。差异是设计，但**映射表本身
 * 不该有三份** —— 那一列列抄的名单是"加一列要记得改三处"的经典现场，而漏改的那一处不会报错，
 * 只会安静地少一个字段（本 issue 加 `audience` 时就是撞在这上面才顺手合并的）。
 *
 * 所以这里只留两个入口，把差异收成参数：全量的 `toNoticeRecord`，与"只要信头字段"的
 * `toNoticeRecordWithoutContent`。加列时两个入口共用同一段映射，漏改会**编译不过**。
 */

/** 全量映射：含附件清单与 AI 摘要 JSON（详情页、列表页、检索索引用）。 */
export function toNoticeRecord(row: typeof notices.$inferSelect): NoticeRecord {
  return {
    ...baseFields(row),
    attachments: parseAttachments(row.attachmentsJson),
    aiSummary: safeParseJson(row.aiSummaryJson),
    // 审读记录（issue #47）：与 `aiSummary` 不同，它在**这里**就解析成形 ——
    // 摘要的形状有三个消费方各有各的读法（页面 / 检索 / feed），而审读记录只有一个读法，
    // 且**列表页与详情页必须拿到同一份**。让两个调用点各解析一次，就是给"两处口径分家"
    // 留一个口子（那正是本仓栽过多次的那类缺口）。坏数据由 `parseImpactReviews` 吞掉。
    impactReviews: parseImpactReviews(safeParseJson(row.impactReviewJson)),
  };
}

/**
 * 只映射"通知邮件要用的那几列"：附件与摘要固定为空。
 *
 * 为什么不让这里也读真值：`notify-new-notices` 与 `send-deadline-reminders` 每天把
 * **全量候选**取出来在应用层筛，多解析一列的 JSON 就是白花一份开销；而邮件模板本来
 * 也不用这两项。真要用时请显式改用 `toNoticeRecord` —— 别让空值悄悄变成"没有附件"。
 */
export function toNoticeRecordWithoutContent(row: typeof notices.$inferSelect): NoticeRecord {
  return {
    ...baseFields(row),
    attachments: [],
    aiSummary: null,
    // 同上：邮件那条路径不读摘要，也不读审读记录（它两个都是"内容"）
    impactReviews: [],
  };
}

/** 两个入口共用的字段映射（加列只改这里）。 */
function baseFields(
  row: typeof notices.$inferSelect,
): Omit<NoticeRecord, 'attachments' | 'aiSummary' | 'impactReviews'> {
  return {
    id: row.id,
    sourceId: row.sourceId,
    title: row.title,
    agency: row.agency,
    url: row.url,
    publishedAt: row.publishedAt,
    deadlineAt: row.deadlineAt,
    status: row.status as NoticeRecord['status'],
    categoryTags: safeParseJsonArray(row.categoryTagsJson),
    bodyText: row.bodyText,
    summaryModel: row.summaryModel,
    fetchedAt: row.fetchedAt,
    firstSeenAt: row.firstSeenAt,
    genre: row.genre as NoticeRecord['genre'],
    genreBasis: row.genreBasis,
    genreEvidence: row.genreEvidence as NoticeRecord['genreEvidence'],
    audience: row.audience as NoticeRecord['audience'],
    audienceBasis: row.audienceBasis,
    outboundClicks: row.outboundClicks,
    versionOf: row.versionOf,
    versionSeq: row.versionSeq,
  };
}

/** 附件清单列是 JSON-in-TEXT：坏项静默丢掉，绝不让一行脏数据打断整页渲染。 */
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
