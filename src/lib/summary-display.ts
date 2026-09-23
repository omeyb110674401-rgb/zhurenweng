import type { NoticeStatus } from '../db/types.ts';
import type { SummaryStatus } from './summary-content.ts';

/**
 * 摘要区的显示态（issue #58）：把详情页「这一段现在该说什么」收成一个纯函数。
 *
 * 背景：`summary_status` 默认 `pending`，而摘要任务的入队条件**排除已截止条目**
 * （issue #4 的设计：截止后再提意见无意义，不必再生成）。两者组合起来，库里 108 条
 * 已截止条目被永久标成「摘要生成中」—— 一个不会兑现的承诺。修法不是在页面里
 * 再加一个 `if`，而是把「会不会生成」这件事写成一处可测的判定。
 *
 * `SUMMARY_NOT_SUMMARIZED_STATUS` 由 `src/db/repo/summaries.ts` 的入队过滤直接 import：
 * 队列与文案门**同源**。分家成两份的后果见 `llm-availability.ts` 的头注 ——
 * 「两处各写一份、迟早分家成界面撒谎」。
 */
export const SUMMARY_NOT_SUMMARIZED_STATUS: NoticeStatus = 'closed';

export type SummaryDisplayState =
  | 'view'
  | 'generating'
  | 'review'
  | 'not-generated'
  | 'unavailable';

export interface SummaryDisplayInput {
  /** 库里已有摘要 JSON —— 与 summary_status 不一致时以它为准（见下的优先级） */
  hasSummary: boolean;
  /** notices.summary_status；条目不存在时按 'pending' 传入 */
  summaryStatus: SummaryStatus;
  /** notices.status 的**库列值**，不用 effectiveStatus（理由见 summaryDisplayState） */
  noticeStatus: NoticeStatus;
  /** llmReady()：端口不可用时不能说「生成中」 */
  llmReady: boolean;
}

/**
 * 优先级是有意的，别重排：
 * 1. `hasSummary` 永远第一 —— 已截止但已有摘要的条目照常渲染，这次修改**绝不能**
 *    把它误伤成「未生成」（库里已有的内容被界面藏起来，比文案不精确严重得多）。
 * 2. 端口不可用 → 「暂未启用」（issue #22 的既有门控，语义不变）。
 * 3. `failed_review` → 人工复核：这条与截止无关，队列里就该说复核。
 * 4. `pending` + 已截止 → 「未生成摘要」：入队条件永不放行，所以它不会再来。
 * 5. 其余 → 「生成中」。
 *
 * 第 4 条判据用库列 `notices.status` 而不是页面上的 `effectiveStatus`：入队过滤用的
 * 就是前者，跟着它才不会自相矛盾。代价是「库里还写着 open、今天刚过期」的条目会让
 * 「生成中」多挂一天（诚实的上界：它确实还在队列里）；反过来用 effectiveStatus 则会
 * 在同步把状态写回之前，就把一条仍会生成摘要的条目说成「未生成」—— 那是真话变假话。
 */
export function summaryDisplayState(input: SummaryDisplayInput): SummaryDisplayState {
  if (input.hasSummary) return 'view';
  if (!input.llmReady) return 'unavailable';
  if (input.summaryStatus === 'failed_review') return 'review';
  if (input.summaryStatus === 'pending' && input.noticeStatus === SUMMARY_NOT_SUMMARIZED_STATUS) {
    return 'not-generated';
  }
  return 'generating';
}
