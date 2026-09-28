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
  countCjk,
  excerptForPrompt,
} from '../../src/lib/attachment-select.ts';
import { attachmentRole } from '../../src/lib/attachment-select.ts';
import {
  SUMMARY_TIERS,
  emptyFeedReport,
  feedAllowance,
  feedFitsAll,
  summaryTierFor,
  type FeedReport,
  type SummaryTier,
} from '../../src/lib/attachment-feed.ts';
import { listNoticeAttachmentTexts } from '../../src/db/repo/attachments.ts';
import { countExplanationSections } from '../../src/lib/explanation-coverage.ts';
import { countChangeMarkers } from '../../src/lib/change-coverage.ts';
import type { DraftSource } from '../../src/lib/ports.ts';
import { llmReady, llmUnavailableReason } from '../../src/lib/llm-availability.ts';
import { sendTaskFailureAlert } from '../../src/lib/alerts.ts';
import { syncNoticesToSearchIndex } from '../../src/lib/search/sync.ts';
import {
  buildQuotedSummaryWithTally,
  llmModelName,
  type QuotedStructuredSummary,
} from '../../src/lib/summary-content.ts';
import {
  buildSummaryDiagnostics,
  describeDiagnostics,
  diagnosticsOfError,
  type SummaryFieldCounts,
} from '../../src/lib/summary-diagnostics.ts';
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
 * 预算从 `src/lib/attachment-feed.ts` 来（issue #86 第 3 刀起**按受众面分档**），
 * 这一层只负责按预算截取，数字不在这里写死：
 * - 条数 `MAX_FILES_PER_NOTICE`（仓库层已按字数降序取前 N 个，字数多更可能是草案本文）；
 * - 每份 `budget.perSource` 字，且**按结构感知截取**（`excerptForPrompt` 优先保留
 *   「第 X 条」锚点窗口，不是简单取前 N 字 —— 草案开头的目录与起草说明没有条文）；
 * - 全部来源合计不超过 `budget.total` 个汉字，且**每一份都有保底份额**（`budget.minShare`）：
 *   实测 `41f2e22e` 那三份里，一份 35,980 字的编制说明把预算吃光，真正要读的条文只送进去
 *   500 字。保底是"不许出现这种情况"，不是"把预算摊平"。
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
  return (await feedPlanForSummary(target)).sources;
}

/**
 * 喂入计划（issue #86 第 3 刀）：条文 **+ 这一轮到底喂了什么**。
 *
 * 为什么要单独有它：`draftSourcesForSummary` 只回答"喂了什么"，而"**谁被挤掉了**"
 * 此前无处可问 —— 预算不够时那份附件既不进 `draftSources`、也不留任何痕迹，
 * 于是"模型没读到"与"我们没喂"在库里长得一模一样（#79 卡住的原因）。
 *
 * 档位由受众面定（`summaryTierFor`）：公众广域走重档。判据与预算都从
 * `src/lib/attachment-feed.ts` 来，脚本与生产共用一份，不在这里另写数字。
 */
export async function feedPlanForSummary(
  target: PendingSummaryTarget,
): Promise<{ tier: SummaryTier; sources: DraftSource[]; report: FeedReport }> {
  const tier = summaryTierFor(target.audience);
  const budget = SUMMARY_TIERS[tier];
  const report = emptyFeedReport(tier);
  if (!attachmentTextFeedsSummary()) return { tier, sources: [], report };
  const rows = await listAttachmentsForSummary(target.id, {
    minChars: MIN_DRAFT_CJK_CHARS,
    limit: MAX_FILES_PER_NOTICE,
  });
  const sources: DraftSource[] = [];
  // 先把每一份按单份上限各切一刀 —— 判"装不装得下"必须看**真正要送进去的那一截**的汉字数，
  // 不能看原文：实测那批环保标准的编制说明 35,980 字里只有约 12,400 个汉字，8,000 字符的窗口
  // 只装到 2,753 个；按原文算会把一个明明装得下的条目判成装不下，白切一刀。
  const planned = rows.map((row) => {
    const window = excerptForPrompt(row.text, budget.perSource).trim();
    return {
      row,
      window,
      windowCjk: countCjk(window),
      fullCjk: countCjk(row.text),
      fullChars: row.text.trim().length,
      role: attachmentRole(row.name),
    };
  });
  // 全都装得下 ⇒ 一份都不截（实测 `41f2e22e` 那条走的就是这一支：三份窗口合计 7,913 汉字）。
  const fitsAll = feedFitsAll(planned.map((item) => item.windowCjk), budget.total);
  let usedCjk = 0;
  for (const [index, plan] of planned.entries()) {
    const allowance = fitsAll
      ? budget.perSource
      : // 装不下时才动用保底：后面还没轮到的那些各留一份"它们真的用得完"的额度
        // （`feedAllowance` 的注释解释了为什么只留用得完的那部分）
        feedAllowance(
          planned.slice(index + 1).map((item) => item.fullCjk),
          { used: usedCjk, budget },
        );
    if (allowance <= 0) {
      report.starved.push({ name: plan.row.name, fullCjk: plan.fullCjk });
      continue;
    }
    const text = fitsAll ? plan.window : excerptForPrompt(plan.row.text, allowance).trim();
    if (text === '') continue;
    const fedCjk = countCjk(text);
    usedCjk += fedCjk;
    sources.push({ name: plan.row.name, url: plan.row.url, text, role: plan.role });
    report.sources.push({
      name: plan.row.name,
      role: plan.role,
      fullCjk: plan.fullCjk,
      fedCjk,
      chars: text.length,
      allowance,
      truncated: text.length < plan.fullChars,
    });
  }
  report.usedCjk = usedCjk;
  return { tier, sources, report };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带重试的 LLM 调用：全部尝试耗尽仍失败时抛出最后一次错误。
 * 首调 + SUMMARY_MAX_RETRIES 次重试（如 3 → 共 4 次尝试）。
 *
 * 返回 `attempts`（第几次调用成功，1 基）：它此前只出现在 stdout 的日志行里，
 * 事后查不到 —— 而"这条试了 4 次才成功"与"一次就成"在诊断上不是同一件事
 * （前者说明通道不稳，重跑策略要另算）。
 */
async function summarizeWithRetry(
  llm: LlmPort,
  target: PendingSummaryTarget,
  ctx: JobContext,
  draftSources: DraftSource[],
  tier: SummaryTier,
): Promise<{ summary: QuotedStructuredSummary; attempts: number }> {
  const input: LlmSummarizeInput = {
    title: target.title,
    bodyText: target.bodyText ?? '',
    url: target.url,
    // 档位随输入一起走：适配器那两段正文的最后一道防线要与这里的预算同档
    // （否则重档喂到 16,000 字符会被标准档的 10,000 静默切掉尾巴）。
    tier,
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
      const summary = (await llm.summarize(input)) as QuotedStructuredSummary;
      return { summary, attempts: attempt + 1 };
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
    // 重档（公众广域）跑了几条：用户拍板的"分级投入"到底分了多少，这一行是它的量具
    let deepCount = 0;
    for (const target of targets) {
      // 条文在进入重试循环**之前**算一次：重试不该重读一遍库、更不该在两次尝试之间
      // 因为预算边界变化而送出不同输入（同一条目的多次调用必须是同一份提示词）。
      const { tier, sources: draftSources, report: feedReport } = await feedPlanForSummary(target);
      const draftChars = draftSources.reduce((sum, item) => sum + countCjk(item.text), 0);
      if (draftChars > 0) fedCount += 1;
      if (tier === 'deep') deepCount += 1;
      // 说明小节数只在"本轮真喂了说明"时才算：没喂却报一个数，等于让页面去解释
      // 一份模型根本没读过的文件。分母从**全文**算（不是喂进去的那一截），理由见
      // explanation-coverage.ts：拿喂进去的那一截数分母，窗口外的内容永远不会出现在
      // "还差多少"那句话里。
      const fullTexts = await listNoticeAttachmentTexts(target.id);
      // 改动表述计数（issue #86 第 2 刀）：**分母从全部附件正文算**，不是喂进去的那一截 ——
      // 与说明小节数同一条规矩（拿喂进去的那一截数分母就是自证：窗口外的改动永远不会
      // 出现在"还差多少"那句话里）。它不再按体裁门控：那份门控正是 #79 那个空栏的成因。
      const changeMarkerCount = countChangeMarkers(fullTexts.map((row) => row.text).join(' '));
      const explanationSections = draftSources.some((source) => source.role === 'explanation')
        ? countExplanationSections(
            fullTexts
              .filter((row) => attachmentRole(row.name) === 'explanation')
              .map((row) => row.text)
              .join(' '),
          )
        : null;
      try {
        const { summary, attempts } = await summarizeWithRetry(llm, target, ctx, draftSources, tier);
        // draftSources 一并交给归一化：条文要点必须能反查到出处才落库（issue #57 第 6 步）；
        // tally 是这一次反查丢掉了多少条（issue #86 第 0 刀）—— 这两个出口走的是同一份实现，
        // 所以"诊断说没丢"与"实际没丢"不可能分家。
        const { summary: quoted, tally } = buildQuotedSummaryWithTally(
          summary,
          summary.quotes,
          draftSources,
          explanationSections,
          changeMarkerCount,
        );
        const kept: SummaryFieldCounts = {
          keyPoints: quoted.keyPoints.length,
          explanationPoints: quoted.explanationPoints.length,
          channels: quoted.channels.length,
          impacts: quoted.impacts.length,
          changes: quoted.changes.length,
        };
        // 诊断与摘要**一起**落库：它描述的就是这一列摘要是哪一次调用产出的
        const diagnostics = buildSummaryDiagnostics(summary.diagnostics, {
          model,
          provider: llm.provider,
          attempts,
          kept,
          quoteNotFound: tally.quoteNotFound,
          // 喂入清单（第 3 刀）：端口看不到选取过程，只有这里知道"哪一份被预算挤掉了"
          feed: feedReport,
        });
        await saveNoticeSummary({
          id: target.id,
          summaryJson: JSON.stringify(quoted),
          summaryModel: model,
          diagnosticsJson: JSON.stringify(diagnostics),
        });
        // 只有**摘要真的用了**才标记（失败重试耗尽的条目不能留下「条文已接入」的痕迹，
        // 否则详情页会宣布一件没发生过的事）
        if (draftSources.length > 0) {
          await markAttachmentsFedToSummary(target.id, draftSources.map((item) => item.url));
        }
        succeeded += 1;
        ctx.logger(
          `条目 ${target.id} 摘要完成（${describeDiagnostics(diagnostics)}）`,
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
        // 拿到响应之后才失败的调用，错误上带着诊断（issue #86）：那正是最需要原始输出的
        // 场合（"模型输出不是合法 JSON"、"必填段不合格"此前只留下一句 200 字以内的摘要）。
        // 请求根本没发出去时没有响应可诊断，此时**不写**（undefined ⇒ 不碰那一列）。
        // 有响应诊断时把这份喂入清单也挂上：事后要问的第一个问题就是"它到底看到了什么"，
        // 而失败的那几次调用恰恰最需要这个答案（端口看不到选取过程，只有这里知道）。
        const failedDiagnostics = diagnosticsOfError(error);
        await markNoticeSummaryForReview(
          target.id,
          failedDiagnostics === null
            ? undefined
            : JSON.stringify({ ...failedDiagnostics, feed: feedReport }),
        );
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
      `摘要任务完成：成功 ${succeeded} 条，转人工复核 ${sentToReview} 条（本轮用到附件条文输入的条目 ${fedCount} 条，其中重档 ${deepCount} 条；附件输入档位 ${attachmentMode()}）`,
    );
  },
};
