import { upsertNotice } from '@/db/repo/notices';
import { upsertSource } from '@/db/repo/sources';
import { daysUntil, normalizeDateText } from '@/lib/dates';
import { noticeIdForUrl } from '@/lib/notice-id';
import { syncNoticesToSearchIndex } from '@/lib/search/sync';
import type { NoticeStatus } from '@/db/types';
import { adminGuard, redirectToAdmin } from '../guard';

/**
 * 手动补录（issue #12）：POST /admin/notices（结构化表单）。
 *
 * 与爬虫完全相同的入库管线：以原文 URL 为唯一键幂等去重（条目 id 同为
 * URL 的 SHA-256 前缀，noticeIdForUrl）→ upsertNotice → 检索索引同步钩子；
 * 摘要列保持 pending，由摘要任务下一轮自动生成 AI 摘要。
 * 补录条目统一登记在专用源「manual（人工补录）」下，健康看板可见。
 */

// 每次提交都实时读写库并同步索引，禁止静态优化与缓存。
export const dynamic = 'force-dynamic';

/** 人工补录专用源（与源适配器一样占用 sources 行，看板可见） */
const MANUAL_SOURCE_ID = 'manual';

/** 状态推导：与爬虫一致 —— 截止日期早于今天 → 已截止；无截止日期默认征求意见中。 */
function deriveStatus(deadlineAt: string | null, now: Date): NoticeStatus {
  const days = daysUntil(deadlineAt, now);
  return days !== null && days < 0 ? 'closed' : 'open';
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const denied = adminGuard(request, url);
  if (denied) return denied;

  const form = await request.formData();
  const title = String(form.get('title') ?? '').trim();
  const agency = String(form.get('agency') ?? '').trim();
  const urlText = String(form.get('url') ?? '').trim();
  const publishedInput = String(form.get('publishedAt') ?? '').trim();
  const deadlineInput = String(form.get('deadlineAt') ?? '').trim();
  const bodyText = String(form.get('bodyText') ?? '').trim() || null;

  if (!title || !agency || !urlText) {
    return redirectToAdmin('error=missing_fields');
  }
  let officialUrl: URL;
  try {
    officialUrl = new URL(urlText);
  } catch {
    return redirectToAdmin('error=invalid_url');
  }
  if (officialUrl.protocol !== 'https:' && officialUrl.protocol !== 'http:') {
    return redirectToAdmin('error=invalid_url');
  }
  const publishedAt = publishedInput ? normalizeDateText(publishedInput) : null;
  const deadlineAt = deadlineInput ? normalizeDateText(deadlineInput) : null;
  if ((publishedInput && !publishedAt) || (deadlineInput && !deadlineAt)) {
    return redirectToAdmin('error=invalid_date');
  }

  const now = new Date();
  const id = noticeIdForUrl(officialUrl.toString());

  // 补录源行（notices.source_id 外键要求先存在）；最近成功时间 = 本次补录时间
  await upsertSource({
    id: MANUAL_SOURCE_ID,
    name: '人工补录',
    adapterType: 'manual',
    healthy: true,
    lastSuccessAt: now.toISOString(),
  });

  const result = await upsertNotice({
    id,
    sourceId: MANUAL_SOURCE_ID,
    title,
    agency,
    url: officialUrl.toString(),
    publishedAt,
    deadlineAt,
    status: deriveStatus(deadlineAt, now),
    categoryTags: [],
    bodyText,
    attachments: [],
    fetchedAt: now.toISOString(),
  });

  // 索引同步钩子：补录即刻可被检索；失败只降级记日志，由重建任务兜底
  try {
    await syncNoticesToSearchIndex([id], (message) => console.log(`[admin] ${message}`));
  } catch (error) {
    console.error(
      `[admin] 补录条目 ${id} 检索索引同步失败（由重建任务兜底）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  console.log(
    `[admin] 手动补录完成：notice=${id} source=${MANUAL_SOURCE_ID} result=${result}`,
  );

  return redirectToAdmin(result === 'inserted' ? 'ok=notice_inserted' : 'ok=notice_updated');
}
