import { createLlmPort } from '../../src/lib/ports.ts';
import { envInt } from '../../src/lib/env-int.ts';
import { errorMessage } from '../../src/lib/errors.ts';
import { attachmentTextFeedsSummary, attachmentMode } from '../../src/lib/attachment-mode.ts';
import {
  listAttachmentsForSummary,
  markAttachmentsFedToSummary,
} from '../../src/db/repo/attachments.ts';
import {
  MAX_FILES_PER_NOTICE,
  MIN_DRAFT_CJK_CHARS,
  PROMPT_CHARS_PER_ATTACHMENT,
  TARGET_TOTAL_CJK_CHARS,
  countCjk,
  excerptForPrompt,
} from '../../src/lib/attachment-select.ts';
import { attachmentRole } from '../../src/lib/attachment-select.ts';
import { listNoticeAttachmentTexts } from '../../src/db/repo/attachments.ts';
import { countExplanationSections } from '../../src/lib/explanation-coverage.ts';
import type { DraftSource } from '../../src/lib/ports.ts';
import { llmReady, llmUnavailableReason } from '../../src/lib/llm-availability.ts';
import { sendTaskFailureAlert } from '../../src/lib/alerts.ts';
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
const MAX_RETRIES = envInt('SUMMARY_MAX_RETRIES', 3, { min: 0, max: 10 });
/** 重试退避基数（毫秒），按 2 的幂指数递增：base, 2*base, 4*base … */
const RETRY_BASE_DELAY_MS = envInt('SUMMARY_RETRY_DELAY_MS', 500, { min: 0 });

/**
 * 本条目可以喂给摘要的附件条文（issue #57 第 5 步）。
 *
 * 三道预算叠加在这里，而不是分散到仓库层与提示词层：
 * - 条数 `MAX_FILES_PER_NOTICE`（仓库层已按字数降序取前 N 个，字数多更可能是草案本文）；
 * - 每份 `PROMPT_CHARS_PER_ATTACHMENT` 字，且**按结构感知截取**（`excerptForPrompt` 优先保留
 *   「第 X 条」锚点窗口，不是简单取前 N 字 —— 草案开头的目录与起草说明没有条文）；
 * - 全部条文合计不超过 `TARGET_TOTAL_CJK_CHARS` 个汉字（超出的整份不送，而不是把最后一份切一半：
 *   半截条文会让模型把截断处当成规定本身）。
 *
 * `ATTACHMENT_TEXT` 不是 `on` 时返回空数组 —— 这就是 `shadow` 与 `on` 的**唯一**区别：
 * 影子档照样下载、解析、写库出审计数，只是不喂给模型，所以页面一个字都不会变。
 */
/**
 * 导出给 `scripts/reset-summaries-for-redraft.mjs` 用（issue #67）：判断「这条现在重跑
 * 到底会不会带上条文」必须与真正喂提示词时**同一条判据**，不能在脚本里另写一份
 * （门槛、预算、档位三处都可能漂移，而漂移的表现是脚本说"有条文"、真跑起来却没有）。
 */
export async function draftSourcesForSummary(target: PendingSummaryTarget): Promise<DraftSource[]> {
  if (!attachmentTextFeedsSummary()) return [];
  const rows = await listAttachmentsForSummary(target.id, {
    minChars: MIN_DRAFT_CJK_CHARS,
    limit: MAX_FILES_PER_NOTICE,
  });
  const sources: DraftSource[] = [];
  let usedCjk = 0;
  for (const row of rows) {
    if (usedCjk >= TARGET_TOTAL_CJK_CHARS) break;
    const text = excerptForPrompt(
      row.text,
      Math.min(PROMPT_CHARS_PER_ATTACHMENT, TARGET_TOTAL_CJK_CHARS - usedCjk),
    ).trim();
    if (text === '') continue;
    usedCjk += countCjk(text);
    sources.push({ name: row.name, url: row.url, text, role: attachmentRole(row.name) });
  }
  return sources;
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
  draftSources: DraftSource[],
): Promise<QuotedStructuredSummary> {
  const input: LlmSummarizeInput = {
    title: target.title,
    bodyText: target.bodyText ?? '',
    url: target.url,
    ...(draftSources.length > 0 ? { draftSources } : {}),
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
    '对已入库且摘要缺失的未截止条目调用 LLM 生成结构化摘要（附件条文按档位作为第二路输入；重试 3 次后转人工复核）',
  async run(ctx: JobContext): Promise<void> {
    // LLM 端口未配置时**整轮跳过**（issue #22）：createLlmPort 会抛错，此前表现为
    // 「任务 summarize-notices 失败」——每轮一条失败日志，配置了 ALERT_EMAIL 时还会
    // 每天一封任务级告警邮件，而这件事并不会因为重试而好转。跳过并说清原因，
    // 配置补齐后自动恢复（与 /subscribe 的 mailerReady 门控同一套路数）。
    if (!llmReady()) {
      // 原因直接取门控的实现（issue #25）：换服务商后这句日志不必再改，
      // 也不会出现「日志说的和界面判的不一致」
      ctx.logger(`LLM 端口未配置，本轮跳过摘要任务：${llmUnavailableReason() ?? '原因未知'}`);
      return;
    }
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
    let fedCount = 0;
    for (const target of targets) {
      // 条文在进入重试循环**之前**算一次：重试不该重读一遍库、更不该在两次尝试之间
      // 因为预算边界变化而送出不同输入（同一条目的多次调用必须是同一份提示词）。
      const draftSources = await draftSourcesForSummary(target);
      const draftChars = draftSources.reduce((sum, item) => sum + countCjk(item.text), 0);
      if (draftChars > 0) fedCount += 1;
      // 说明小节数只在"本轮真喂了说明"时才算：没喂却报一个数，等于让页面去解释
      // 一份模型根本没读过的文件。分母从**全文**算（不是喂进去的那一截），理由见
      // explanation-coverage.ts：拿喂进去的那一截数分母，窗口外的内容永远不会出现在
      // "还差多少"那句话里。
      const fullTexts = await listNoticeAttachmentTexts(target.id);
      const explanationSections = draftSources.some((source) => source.role === 'explanation')
        ? countExplanationSections(
            fullTexts
              .filter((row) => attachmentRole(row.name) === 'explanation')
              .map((row) => row.text)
              .join(' '),
          )
        : null;
      try {
        const summary = await summarizeWithRetry(llm, target, ctx, draftSources);
        // draftSources 一并交给归一化：条文要点必须能反查到出处才落库（issue #57 第 6 步）
        const quoted = buildQuotedSummary(
          summary,
          summary.quotes,
          draftSources,
          explanationSections,
        );
        await saveNoticeSummary({
          id: target.id,
          summaryJson: JSON.stringify(quoted),
          summaryModel: model,
        });
        // 只有**摘要真的用了**才标记（失败重试耗尽的条目不能留下「条文已接入」的痕迹，
        // 否则详情页会宣布一件没发生过的事）
        if (draftSources.length > 0) {
          await markAttachmentsFedToSummary(target.id, draftSources.map((item) => item.url));
        }
        succeeded += 1;
        ctx.logger(
          `条目 ${target.id} 摘要完成（model=${model}${draftChars > 0 ? `，附件条文 ${draftSources.length} 份 / ${draftChars} 字` : ''}）`,
        );
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
        const message = errorMessage(error);
        await markNoticeSummaryForReview(target.id);
        sentToReview += 1;
        // 摘要失败告警（issue #12）：转人工复核的同时通知站长，同日 × 任务 × 源去重
        await sendTaskFailureAlert({
          jobName: 'summarize-notices',
          sourceId: target.sourceId,
          error: `条目 ${target.id} 摘要重试耗尽转人工复核：${message}`,
          now: ctx.now(),
          log: ctx.logger,
        });
        ctx.logger(
          `条目 ${target.id} 摘要失败：已重试 ${MAX_RETRIES} 次仍失败，转人工复核（最后错误：${message}）`,
        );
      }
    }
    ctx.logger(
      `摘要任务完成：成功 ${succeeded} 条，转人工复核 ${sentToReview} 条（本轮用到附件条文输入的条目 ${fedCount} 条，档位 ${attachmentMode()}）`,
    );
  },
};
