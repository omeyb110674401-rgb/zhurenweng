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

/**
 * 「条文在哪」的四种答案（issue #57 第 6 步）。
 *
 * 判据只用**仓库里已经存在的事实**（附件行的状态与字数），不看 `ATTACHMENT_TEXT` 档位：
 * 档位是运维配置，读者既不关心也看不懂；他们要的是「这页到底有没有替我读过条文」。
 *
 * 刻意区分「读到了」与「读到了并且用来写本页要点」：影子档下前者成立、后者不成立，
 * 这时页面只说附件能读、不暗示摘要里有条文 —— 那正是 issue #22/#58 反复清掉的那类
 * 「承诺还没发生的事」。
 */
export type DraftAvailability =
  | { kind: 'read-and-used'; files: number; chars: number }
  | { kind: 'read-not-used'; files: number }
  | { kind: 'unreadable'; files: number }
  | { kind: 'no-attachments' }
  | { kind: 'not-probed' };

/** `draftAvailability` 需要的字段（结构型入参，避免显示层依赖仓储模块）。 */
export interface DraftAvailabilityInput {
  total: number;
  fedChars: number;
  okFiles: number;
}

export function draftAvailability(report: DraftAvailabilityInput | null): DraftAvailability {
  if (report === null) return { kind: 'not-probed' };
  if (report.total === 0) return { kind: 'no-attachments' };
  if (report.fedChars > 0) {
    // 份数取上界 okFiles；一条都没标 ok 却又有 fedChars（不该发生）时至少报 1 份，
    // 免得页面写出「已读取 0 份附件共 3 万字」这种自相矛盾的话。
    return { kind: 'read-and-used', files: Math.max(report.okFiles, 1), chars: report.fedChars };
  }
  if (report.okFiles > 0) return { kind: 'read-not-used', files: report.okFiles };
  return { kind: 'unreadable', files: report.total };
}
