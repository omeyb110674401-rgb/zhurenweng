import { getNoticeSummary, resetNoticeSummaryForRetry, saveNoticeSummary } from '@/db/repo/summaries';
import { normalizeDateText } from '@/lib/dates';
import { buildQuotedSummary } from '@/lib/summary-content';
import { syncNoticesToSearchIndex } from '@/lib/search/sync';
import { adminGuard, redirectToAdmin } from '../guard';

/**
 * 摘要人工复核处置（issue #12）：POST /admin/review（复核队列的两个表单）。
 *
 * - action=reset：重置重试 —— 清空摘要列并置回 pending，摘要任务下一轮
 *   自动重新生成（仅对 failed_review 状态生效）；
 * - action=save：人工修订摘要文本 → 归一化为五段式 JSON（quote 为空，详情页
 *   自动隐藏引用块）→ 落库置 done（summary_model=manual）并同步检索索引。
 *
 * 处置结果经 303 重定向的查询参数回传横幅（?ok= / ?error=）。
 */

// 每次提交都实时读写库并同步索引，禁止静态优化与缓存。
export const dynamic = 'force-dynamic';

/** 人工保存的摘要模型名（详情页「摘要模型」位展示，与自动摘要区分） */
export const MANUAL_SUMMARY_MODEL = 'manual';

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const denied = adminGuard(request, url);
  if (denied) return denied;

  const form = await request.formData();
  const noticeId = String(form.get('noticeId') ?? '').trim();
  const action = String(form.get('action') ?? '').trim();
  if (!noticeId) {
    return redirectToAdmin('error=notice_not_found');
  }

  if (action === 'reset') {
    const reset = await resetNoticeSummaryForRetry(noticeId);
    return reset
      ? redirectToAdmin('ok=review_reset')
      : redirectToAdmin('error=not_in_review');
  }

  if (action === 'save') {
    const what = String(form.get('what') ?? '').trim();
    const who = String(form.get('who') ?? '').trim();
    const howToComment = String(form.get('howToComment') ?? '').trim();
    const deadlineInput = String(form.get('deadline') ?? '').trim();
    if (!what || !who || !howToComment) {
      return redirectToAdmin('error=missing_fields');
    }
    const deadline = deadlineInput ? normalizeDateText(deadlineInput) : null;
    if (deadlineInput && !deadline) {
      return redirectToAdmin('error=invalid_date');
    }
    const summary = await getNoticeSummary(noticeId);
    if (!summary) {
      return redirectToAdmin('error=notice_not_found');
    }
    const keyPoints = String(form.get('keyPoints') ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const quoted = buildQuotedSummary({ what, who, keyPoints, deadline, howToComment });
    await saveNoticeSummary({
      id: noticeId,
      summaryJson: JSON.stringify(quoted),
      summaryModel: MANUAL_SUMMARY_MODEL,
    });
    // 索引同步钩子：人工摘要即刻可被检索；失败只降级记日志，由重建任务兜底
    try {
      await syncNoticesToSearchIndex([noticeId], (message) => console.log(`[admin] ${message}`));
    } catch (error) {
      console.error(
        `[admin] 条目 ${noticeId} 人工摘要索引同步失败（由重建任务兜底）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return redirectToAdmin('ok=review_saved');
  }

  return new Response('未知的复核操作', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
