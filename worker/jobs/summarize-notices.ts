import { createLlmPort } from '../../src/lib/ports.ts';
import { syncNoticesToSearchIndex } from '../../src/lib/search/sync.ts';
import {
  buildQuotedSummary,
  llmModelName,
  type QuotedStructuredSummary,
} from '../../src/lib/summary-content.ts';
import {
  listNoticesForSummary,
  markNoticeSummaryForReview,
  saveNoticeSummary,
  type PendingSummaryTarget,
} from '../../src/db/repo/summaries.ts';
import type { LlmPort, LlmSummarizeInput } from '../../src/lib/ports.ts';
import type { Job, JobContext } from '../registry.ts';

/**
 * 摘要任务（issue #4）：扫描 ai_summary_json 为空、状态待生成（pending）且
 * 非已截止的条目 → 调 LLM 端口（输入正文纯文本）→ 归一化为五段式带原文引用的
 * 摘要 JSON（notices.ai_summary_json + summary_model，状态置 done）。
 *
 * 失败策略：单条条目内「首调 + 最多 3 次重试」（指数退避，基数可用
 * SUMMARY_RETRY_DELAY_MS 调整），仍失败则置 failed_review 转人工复核，
 * 此后 worker 不再自动重试（由复核队列人工处理）。单条失败不影响同批其他条目。
 */

/** 失败后的最大重试次数（不含首次调用；共尝试 1 + SUMMARY_MAX_RETRIES 次） */
const MAX_RETRIES = Number(process.env.SUMMARY_MAX_RETRIES ?? 3);
/** 重试退避基数（毫秒），按 2 的幂指数递增：base, 2*base, 4*base … */
const RETRY_BASE_DELAY_MS = Number(process.env.SUMMARY_RETRY_DELAY_MS ?? 500);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带重试的 LLM 调用：全部尝试耗尽仍失败时抛出最后一次错误。
 * 首调 + SUMMARY_MAX_RETRIES 次重试（如 3 → 共 4 次尝试）。
 */
async function summarizeWithRetry(
  llm: LlmPort,
  target: PendingSummaryTarget,
  ctx: JobContext,
): Promise<QuotedStructuredSummary> {
  const input: LlmSummarizeInput = {
    title: target.title,
    bodyText: target.bodyText ?? '',
    url: target.url,
  };
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (attempt > 0) {
      const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      ctx.logger(`条目 ${target.id} 摘要第 ${attempt}/${MAX_RETRIES} 次重试（${delayMs}ms 后）`);
      await sleep(delayMs);
    }
    try {
      return (await llm.summarize(input)) as QuotedStructuredSummary;
    } catch (error) {
      lastError = error;
      ctx.logger(
        `条目 ${target.id} LLM 调用失败（第 ${attempt + 1}/${MAX_RETRIES + 1} 次尝试）：${errorMessage(error)}`,
      );
    }
  }
  throw lastError;
}

export const summarizeNoticesJob: Job = {
  name: 'summarize-notices',
  description:
    '对已入库且摘要缺失的未截止条目调用 LLM 生成五段式结构化摘要（重试 3 次后转人工复核）',
  async run(ctx: JobContext): Promise<void> {
    const llm = createLlmPort();
    const model = llmModelName(llm);
    const targets = await listNoticesForSummary();

    if (targets.length === 0) {
      ctx.logger('无待摘要条目');
      return;
    }
    ctx.logger(`待摘要条目 ${targets.length} 条（model=${model}）`);

    let succeeded = 0;
    let sentToReview = 0;
    for (const target of targets) {
      try {
        const summary = await summarizeWithRetry(llm, target, ctx);
        const quoted = buildQuotedSummary(summary, summary.quotes);
        await saveNoticeSummary({
          id: target.id,
          summaryJson: JSON.stringify(quoted),
          summaryModel: model,
        });
        succeeded += 1;
        ctx.logger(`条目 ${target.id} 摘要完成（model=${model}）`);
        // 索引同步钩子（issue #8）：摘要落库后重刷该条目，摘要文本即刻可被检索；
        // 失败只降级记日志，由重建任务兜底，不影响摘要主管线
        try {
          await syncNoticesToSearchIndex([target.id], ctx.logger);
        } catch (error) {
          ctx.logger(
            `条目 ${target.id} 检索索引同步失败（由重建任务兜底）：${errorMessage(error)}`,
          );
        }
      } catch (error) {
        await markNoticeSummaryForReview(target.id);
        sentToReview += 1;
        ctx.logger(
          `条目 ${target.id} 摘要失败：已重试 ${MAX_RETRIES} 次仍失败，转人工复核（最后错误：${errorMessage(error)}）`,
        );
      }
    }
    ctx.logger(`摘要任务完成：成功 ${succeeded} 条，转人工复核 ${sentToReview} 条`);
  },
};
