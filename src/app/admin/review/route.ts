import { getNoticeSummary, resetNoticeSummaryForRetry, saveNoticeSummary } from '@/db/repo/summaries';
import { normalizeDateText } from '@/lib/dates';
import { buildQuotedSummary, normalizeChannels } from '@/lib/summary-content';
import type { SummaryChannelKind } from '@/lib/ports';
import { syncNoticesToSearchIndex } from '@/lib/search/sync';
import { adminGuard, redirectToAdmin } from '../guard';

/**
 * 摘要人工复核处置（issue #12；issue #55 起为「参与导引」形状）：
 * POST /admin/review（复核队列的两个表单）。
 *
 * - action=reset：重置重试 —— 清空摘要列并置回 pending，摘要任务下一轮
 *   自动重新生成（仅对 failed_review 状态生效）；
 * - action=save：人工修订摘要 → 归一化为落库形状（quote 为空，详情页自动隐藏
 *   引用块）→ 置 done（summary_model=manual）并同步检索索引。
 *
 * 处置结果经 303 重定向的查询参数回传横幅（?ok= / ?error=）。
 */

// 每次提交都实时读写库并同步索引，禁止静态优化与缓存。
export const dynamic = 'force-dynamic';

/** 人工保存的摘要模型名（详情页「摘要模型」位展示，与自动摘要区分） */
export const MANUAL_SUMMARY_MODEL = 'manual';

/**
 * 渠道人工录入：每行一条，格式 `类型|值`（类型可省略，留空则按值自动判断）。
 *
 * 分隔符只用 `|` 而不用 `:` —— 网址本身就带 `://`，按冒号切会把值切坏。
 * 类型词表与校验都交给 normalizeChannels（与模型输出同一份口径），这里只负责拆行。
 */
function parseChannelsLines(raw: string): { kind: string; value: string }[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [declared, ...rest] = line.split('|');
      const value = (rest.length > 0 ? rest.join('|') : declared).trim();
      const kind = rest.length > 0 ? declared.trim() : '';
      return { kind, value };
    })
    .filter((item) => item.value.length > 0);
}

/** 省略类型时按值猜渠道类型（猜错也只是标签不准，值本身照样可核对） */
function inferChannelKind(value: string): SummaryChannelKind {
  if (value.includes('@')) return 'email';
  if (/^[\d+()（）\-.，,、\s]{6,}$/.test(value)) return 'phone';
  if (/^https?:\/\//i.test(value) || /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/.test(value)) return 'online';
  if (/邮?编|号$|路|街|大道/.test(value)) return 'mail';
  return 'other';
}

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
    // 「影响谁」可空（issue #56 第八节：公告壳里通常没有受影响主体，与模型侧同一口径）
    if (!what || !howToComment) {
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
    // 先按行解析并补全类型，再交给 normalizeChannels 做与模型输出同一套的清理
    // （白名单校验、去空、去重、条数上限）—— 不在这里另写一份校验口径。
    const channels = normalizeChannels(
      parseChannelsLines(String(form.get('channels') ?? '')).map((item) => ({
        kind: item.kind || inferChannelKind(item.value),
        value: item.value,
      })),
    );
    const quoted = buildQuotedSummary({
      what,
      who,
      whoCanSubmit: String(form.get('whoCanSubmit') ?? '').trim(),
      afterDeadline: String(form.get('afterDeadline') ?? '').trim(),
      deadline,
      howToComment,
      channels,
    });
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
