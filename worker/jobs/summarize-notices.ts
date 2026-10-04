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
  BODY_DRAFT_LABEL,
  SUMMARY_TIERS,
  bodyLooksLikeDraft,
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
import { buildChangeTable } from '../../src/lib/change-table.ts';
import type { DraftSource } from '../../src/lib/ports.ts';
import { llmReady, llmUnavailableReason } from '../../src/lib/llm-availability.ts';
import { sendTaskFailureAlert } from '../../src/lib/alerts.ts';
import { syncNoticesToSearchIndex } from '../../src/lib/search/sync.ts';
import {
  buildQuotedSummaryWithTally,
  llmModelName,
  type QuotedImpactPoint,
  type QuotedStructuredSummary,
} from '../../src/lib/summary-content.ts';
import {
  buildSummaryDiagnostics,
  capRawOutput,
  describeDiagnostics,
  diagnosticsOfError,
  type ReviewDiagnostics,
  type SummaryFieldCounts,
} from '../../src/lib/summary-diagnostics.ts';
import {
  listNoticesForSummary,
  markNoticeSummaryForReview,
  saveNoticeSummary,
  type PendingSummaryTarget,
} from '../../src/db/repo/summaries.ts';
import {
  createImpactReviewPort,
  impactReviewIndependence,
  impactReviewReady,
  type ImpactReviewPort,
} from '../../src/lib/ports.ts';
import {
  impactReviewRecordsFrom,
  reviewFailureRaw,
  reviewOutcomeOfError,
  serializeImpactReviews,
  type ImpactReviewRecord,
  type ReviewOutcome,
} from '../../src/lib/impact-review.ts';
import { neighborhoodForQuote } from '../../src/lib/impact-review-prompt.ts';
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

/**
 * 失败后的最大重试次数（不含首次调用；共尝试 1 + SUMMARY_MAX_RETRIES 次）。
 *
 * 导出给 `scripts/summarize-now.mjs` 用：它要在"要真跑"那一行如实写出这一次最多几次尝试
 * （那正是这个工具的成本），而从环境变量再推导一遍就是把同一个默认值写两份。
 */
export const MAX_RETRIES = envInt('SUMMARY_MAX_RETRIES', 3, { min: 0, max: 10 });
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
  /** 待喂的一份（附件或正文），预算分配与诊断都按同一份形状走。 */
  interface PlannedSource {
    row: { name: string; url: string; text: string };
    window: string;
    windowCjk: number;
    fullCjk: number;
    fullChars: number;
    role: 'draft' | 'explanation' | 'other';
    origin: 'attachment' | 'body';
  }
  // 先把每一份按单份上限各切一刀 —— 判"装不装得下"必须看**真正要送进去的那一截**的汉字数，
  // 不能看原文：实测那批环保标准的编制说明 35,980 字里只有约 12,400 个汉字，8,000 字符的窗口
  // 只装到 2,753 个；按原文算会把一个明明装得下的条目判成装不下，白切一刀。
  const planned: PlannedSource[] = rows.map(
    (row): PlannedSource => {
      const window = excerptForPrompt(row.text, budget.perSource).trim();
      return {
        row,
        window,
        windowCjk: countCjk(window),
        fullCjk: countCjk(row.text),
        fullChars: row.text.trim().length,
        role: attachmentRole(row.name),
        origin: 'attachment',
      };
    },
  );
  /**
   * 附件侧一份条文都没有（只有说明或什么都没有）、而**正文本身就是条文**时，
   * 把正文也当作一份来源（issue #86 第十六节）。
   *
   * 为什么不看源而是看形状：`cac` 那 7 条实测如此，但"哪个源习惯这么发"是运营知识，
   * 判据得跟着文档走 —— 换成另一个源开始这么发，这里不用改。
   * 为什么只在"附件侧没有条文"时才加：正文与附件同时给条文的形状今天**一条都没有**
   * （实测 7/7 条正文长的都没有可读附件），所以这一支是纯增量；真有那么一天，
   * 两份条文会一起进提示词、由 `fitsAll`/保底照常分配额度。
   */
  const bodyText = target.bodyText ?? '';
  if (!planned.some((item) => item.role !== 'explanation') && bodyLooksLikeDraft(bodyText)) {
    const bodyWindow = excerptForPrompt(bodyText, budget.perSource).trim();
    planned.push({
      row: { name: BODY_DRAFT_LABEL, url: target.url, text: bodyText },
      window: bodyWindow,
      windowCjk: countCjk(bodyWindow),
      fullCjk: countCjk(bodyText),
      fullChars: bodyText.trim().length,
      role: 'draft',
      origin: 'body',
    });
  }
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
    sources.push({
      name: plan.row.name,
      url: plan.row.url,
      text,
      role: plan.role,
      origin: plan.origin,
    });
    report.sources.push({
      name: plan.row.name,
      role: plan.role,
      origin: plan.origin,
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
  logger: (message: string) => void,
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
      logger(`条目 ${target.id} 摘要第 ${attempt}/${MAX_RETRIES} 次重试（${delayMs}ms 后）`);
      await sleep(delayMs);
    }
    try {
      const summary = (await llm.summarize(input)) as QuotedStructuredSummary;
      return { summary, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      logger(
        `条目 ${target.id} LLM 调用失败（第 ${attempt + 1}/${MAX_RETRIES + 1} 次尝试）：${errorMessage(error)}`,
      );
    }
  }
  throw lastError;
}

/**
 * 单条条目的**完整**摘要 —— job 与 `scripts/summarize-now.mjs` 共用这一份实现。
 *
 * 抽出来的理由不是"少写几行"，而是"一次点名重跑必须与日常那一轮走同一条链"：
 * `feedPlanForSummary` → `summarizeWithRetry` → `buildQuotedSummaryWithTally` →
 * `buildChangeTable` → `saveNoticeSummary` → `markAttachmentsFedToSummary` → 检索索引同步。
 * 少了任何一步、或哪一步的判据在工具里另抄一份，工具产出的摘要就与生产产出的**不是同一种东西**，
 * 而这一点从摘要本身看不出来（两者的形状一模一样）。job 的 `run` 从此只负责
 * "跑哪几条"与四个汇总计数。
 *
 * 返回值把三种结局都交出去（成功 / 转人工复核 / 抛错），不在这里吞掉：
 * - `'done'` 与 `'failed_review'` 都**返回结果**（后者已置库、已打过失败日志）；
 * - 这个函数抛出的错误照旧往外冒（取条文失败、附件文本读失败、写失败态本身失败）——
 *   由调用方决定怎么办：job 让它冒到任务级（与抽出来之前逐字相同），
 *   `scripts/summarize-now.mjs` 按条打印后继续跑下一条。
 *
 * 失败告警**刻意留在这里之外**（`onRetriesExhausted` 钩子交给调用方）：告警的去重键是
 * 「本地日历日 × 任务名 × 源」（`src/lib/alerts.ts` 的 `hasAlertSend`），点名工具若顶着
 * `summarize-notices` 这个任务名发信，会把当天这个源**真正**的那封挤掉 ——
 * 那是"工具把生产的告警吃掉"，不是它该有的能力。job 传钩子，于是顺序
 * （置失败态 → 发告警 → 打失败日志）与抽出来之前一字不差。
 */
export interface SummarizeOneNoticeDeps {
  llm: LlmPort;
  /**
   * `llmModelName(llm)` 的结果：落库的 `summary_model` 与诊断里的 `model` 都由它来。
   * 由调用方算一次、整批共用（job 用的那份还要打进"待摘要条目 N 条（model=…）"那一行）。
   */
  model: string;
  /** 日志出口：worker 传 `ctx.logger`（自带 `[worker] 时间戳` 前缀），工具传 stdout */
  logger: (message: string) => void;
  /**
   * 重试耗尽、已置 `failed_review` **之后**、失败日志**之前**的钩子（可选）。
   * job 在这里发任务失败告警（顺序与抽出来之前一字不差）；工具不传 —— 理由见上面那段。
   */
  onRetriesExhausted?: (input: {
    target: PendingSummaryTarget;
    error: string;
  }) => Promise<void> | void;
}

/**
 * 审读那一步（issue #47）：把这一条目的判读送交**第二路**模型判合规性，
 * 拿回一组审读记录（形状与「只减不加」的接受条件全在 `src/lib/impact-review.ts`）。
 *
 * ## 失败一律跳过，绝不让审读把摘要生成带崩
 *
 * 六种失败（端口没配 / 独立性不成立 / 端口构造失败 / 超时 / 调用失败 / 形状非法）走**同一条处置**：记一句日志、
 * 返回空数组 ⇒ 这一批判读**没有审读记录**。这不是"放行"，而是本切片（#47）的过渡语义：
 * 审读层此时只影响"渲染什么文本"，不影响"要不要渲染"，所以没有记录 = 按今天的行为渲染。
 * 门翻转（第 6 条 #52）之后同一件事自动变成"不渲染"（无记录 ⇒ fail-closed），
 * 不需要在这里再改一行 —— 这正是把 fail-closed 放在**门**里而不是放在**worker**里的好处。
 *
 * ## 为什么空判读不调用
 *
 * 没有判读就没有可审的东西：调一次等于白花一次出境调用，而"审读跑了但没东西可判"与
 * "根本没跑"在库里应当长得一样（都是没有记录）。
 */
async function reviewImpactsForSummary(input: {
  target: PendingSummaryTarget;
  impacts: readonly QuotedImpactPoint[];
  /** 本轮喂进提示词的那几份正文：审读要按引用回它们里取邻域（只有 worker 手上有正文） */
  sources: readonly DraftSource[];
  logger: (message: string) => void;
}): Promise<{ records: ImpactReviewRecord[]; diagnostics: ReviewDiagnostics }> {
  const requested = input.impacts.length;
  /** 六种失败共用的那几格（差异只在 status / error / raw 上） */
  const empty = (status: ReviewOutcome, error: string | null): ReviewDiagnostics => ({
    status,
    model: null,
    requested,
    accepted: 0,
    rejected: 0,
    error,
    elapsedMs: null,
  });

  if (requested === 0) return { records: [], diagnostics: empty('skipped', null) };
  if (!impactReviewReady()) {
    const reason = 'IMPACT_REVIEW_PROVIDER 未配置';
    input.logger(`条目 ${input.target.id} 审读跳过：${reason}，这一批判读将没有审读记录`);
    return { records: [], diagnostics: empty('not-configured', reason) };
  }
  /**
   * 独立性核对（#50）：审读侧与生成侧必须**不同来源** —— 用户拍板"带门扩"的前提就是这一条。
   * 不成立就**不跑**：一份同源模型的"通过"会让门看起来在工作，比没有审读更坏。
   */
  const independence = impactReviewIndependence();
  if (!independence.ok) {
    input.logger(
      `条目 ${input.target.id} 审读跳过：审读侧的独立性不成立（${independence.reason}）—— ` +
        '同源模型的"通过"比没有审读更坏',
    );
    return { records: [], diagnostics: empty('not-independent', independence.reason) };
  }
  let port: ImpactReviewPort;
  try {
    port = createImpactReviewPort();
  } catch (error) {
    input.logger(
      `条目 ${input.target.id} 审读端口构造失败，整条跳过：${errorMessage(error)}`,
    );
    return { records: [], diagnostics: empty('port-error', errorMessage(error)) };
  }

  const startedAt = Date.now();
  try {
    const verdicts = await port.review({
      noticeId: input.target.id,
      title: input.target.title,
      items: input.impacts.map((impact) => ({
        quote: impact.quote,
        who: impact.who,
        point: impact.point,
        text: impact.text,
        // 邻域只在这里取得到：正文（`sources`）是 worker 的输入，端口看不到它
        neighborhood: neighborhoodOf(impact, input.sources),
      })),
    });
    const records = impactReviewRecordsFrom({
      impacts: input.impacts,
      verdicts,
      model: port.model,
      reviewedAt: new Date().toISOString(),
    });
    const diagnostics: ReviewDiagnostics = {
      status: 'ok',
      model: port.model,
      requested,
      accepted: records.length,
      // 模型给了、但没被采信的那些（回显对不上 / 同一条两份结论 / 已改却没文本）
      rejected: Math.max(0, verdicts.length - records.length),
      error: null,
      elapsedMs: Date.now() - startedAt,
    };
    input.logger(
      `条目 ${input.target.id} 审读完成：送审 ${requested} 条 / 采信 ${diagnostics.accepted} 条` +
        (diagnostics.rejected > 0 ? ` / 未采信 ${diagnostics.rejected} 条` : ''),
    );
    return { records, diagnostics };
  } catch (error) {
    // 超时 / HTTP / 网络 / 返回形状非法都落在这里。**不重试**：这一轮的判读本来就没渲染出去
    // （过渡期按原文渲染、翻转后不渲染），而重试会把一轮摘要任务拖长 —— 下一轮回填
    // 与审读会整体重跑，代价比重试一次小。
    const status = reviewOutcomeOfError(error);
    const raw = capRawOutput(reviewFailureRaw(error)).raw;
    input.logger(
      `条目 ${input.target.id} 审读未成（${status}），跳过（这一批判读将没有审读记录）：${errorMessage(error)}`,
    );
    return {
      records: [],
      diagnostics: {
        ...empty(status, errorMessage(error)),
        elapsedMs: Date.now() - startedAt,
        ...(raw !== '' ? { raw } : {}),
      },
    };
  }
}

/**
 * 这条判读的**原文邻域**：按 `impact.source`（附件名，由落库时的逐字反查算出）回查到本轮
 * 喂进去的那一份正文，再从正文里按引用前后各取一段。
 *
 * 取不到就给 null，而 `null` 会被提示词显式写成"没有邻域可用" —— **绝不退而用引用自己当邻域**：
 * 那会让"是否超出原文"退化成拿引用证明引用，而它恰恰是 A1 的全部内容。
 */
function neighborhoodOf(
  impact: QuotedImpactPoint,
  sources: readonly DraftSource[],
): string | null {
  if (impact.source === null || impact.source === '') return null;
  const source = sources.find((item) => item.name === impact.source);
  if (source === undefined) return null;
  return neighborhoodForQuote(source.text, impact.quote);
}

/** 一条条目的结局（`error` 与日志、告警里那一句**同源**，不另写一遍）。 */
export interface SummarizeOneNoticeResult {
  outcome: 'done' | 'failed_review';
  /** 这一条实际走的喂入档位（受众面定的，见 `summaryTierFor`） */
  tier: SummaryTier;
  /** 真喂进提示词的条文汉字数；> 0 = 这一条用到了条文输入 */
  fedCjk: number;
  /** 失败时的可读错误；成功时 null */
  error: string | null;
}

export async function summarizeOneNotice(
  target: PendingSummaryTarget,
  deps: SummarizeOneNoticeDeps,
): Promise<SummarizeOneNoticeResult> {
  const { llm, model, logger } = deps;
  // 条文在进入重试循环**之前**算一次：重试不该重读一遍库、更不该在两次尝试之间
  // 因为预算边界变化而送出不同输入（同一条目的多次调用必须是同一份提示词）。
  const { tier, sources: draftSources, report: feedReport } = await feedPlanForSummary(target);
  const draftChars = draftSources.reduce((sum, item) => sum + countCjk(item.text), 0);
  // 说明小节数只在"本轮真喂了说明"时才算：没喂却报一个数，等于让页面去解释
  // 一份模型根本没读过的文件。分母从**全文**算（不是喂进去的那一截），理由见
  // explanation-coverage.ts：拿喂进去的那一截数分母，窗口外的内容永远不会出现在
  // "还差多少"那句话里。
  const fullTexts = await listNoticeAttachmentTexts(target.id);
  // 改动表述计数（issue #86 第 2 刀）：**分母从全部附件正文算**，不是喂进去的那一截 ——
  // 与说明小节数同一条规矩（拿喂进去的那一截数分母就是自证：窗口外的改动永远不会
  // 出现在"还差多少"那句话里）。它不再按体裁门控：那份门控正是 #79 那个空栏的成因。
  // **正文那一份也要算进分母**（第十六节）：正文本身就是条文的那些条目一份附件都没有，
  // 分母不算它的话，页面那行会写"附件正文里没有数到成文的修改表述" —— 而正文里明明有。
  const bodyAsDraft = draftSources.some((source) => source.origin === 'body');
  /**
   * 数分母用的那一份文本：**全部附件正文**（不是喂进去的那一截），正文本身就是条文的
   * 那些条目再把正文接在后面。**同一个局部变量喂给两处** —— 分母（`countChangeMarkers`）
   * 与那张表的骨架（`buildChangeTable`）：两者若各拼一次文本，页面上"检测到 N 处"
   * 与"表里有几行"就会各说各话，而两个数看起来都像真的（这一族问题里最难查的一种）。
   */
  const changeText = [
    ...fullTexts.map((row) => row.text),
    ...(bodyAsDraft ? [target.bodyText ?? ''] : []),
  ].join(' ');
  const changeMarkerCount = countChangeMarkers(changeText);
  const explanationSections = draftSources.some((source) => source.role === 'explanation')
    ? countExplanationSections(
        fullTexts
          .filter((row) => attachmentRole(row.name) === 'explanation')
          .map((row) => row.text)
          .join(' '),
      )
    : null;
  try {
    const { summary, attempts } = await summarizeWithRetry(llm, target, logger, draftSources, tier);
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
    /**
     * 表在**反查之后**才造得出来（"哪一行说的是哪一句"要等 `changes` 定下来），
     * 所以它是落库前补上去的，而不是 `buildQuotedSummaryWithTally` 的返回值。
     * 它只用到 `quoted.changes` 的 `quote` 与那一份 `changeText` —— 后者正是上面数分母
     * 用的同一个字符串，两个数因此不可能分家。
     */
    const changeTable = buildChangeTable(changeText, quoted.changes);
    /**
     * 审读（issue #47 建立，#50 接真模型）：判读在**落库之前**先过一路独立模型。
     *
     * 位置刻意在 `buildQuotedSummaryWithTally` **之后**：审读的输入是"真的落进库的那几条
     * 判读"（过了逐字反查、带着算出来的出处），而不是模型吐出来而可能被丢掉的原始条目 ——
     * 否则审读记录里会有一堆挂不到任何判读上的结论。
     *
     * 它也刻意在 `buildSummaryDiagnostics` **之前**：审读的结果要进同一份诊断
     * （`review` 那一格），否则"这条判读为什么没有审读记录"在库里读不出来。
     */
    const review = await reviewImpactsForSummary({
      target,
      impacts: quoted.impacts,
      // 邻域要从这一轮真喂进去的正文里取（只有这里手上有正文）
      sources: draftSources,
      logger,
    });
    // 诊断与摘要**一起**落库：它描述的就是这一列摘要是哪一次调用产出的
    const diagnostics = buildSummaryDiagnostics(summary.diagnostics, {
      model,
      provider: llm.provider,
      attempts,
      kept,
      quoteNotFound: tally.quoteNotFound,
      // 喂入清单（第 3 刀）：端口看不到选取过程，只有这里知道"哪一份被预算挤掉了"
      feed: feedReport,
      // 审读那一步的结果（#50）：同样只有这里知道
      review: review.diagnostics,
    });
    await saveNoticeSummary({
      id: target.id,
      summaryJson: JSON.stringify({ ...quoted, changeTable }),
      summaryModel: model,
      diagnosticsJson: JSON.stringify(diagnostics),
      impactReviewJson: serializeImpactReviews(review.records),
    });
    // 只有**摘要真的用了**才标记（失败重试耗尽的条目不能留下「条文已接入」的痕迹，
    // 否则详情页会宣布一件没发生过的事）。
    // 正文那一份没有对应的附件行（它的 url 就是公示本身的 url），要滤掉 ——
    // 否则就是拿一个不存在的附件去更新一张表（今天无害，但那是"说得比事实多"）。
    const fedUrls = draftSources
      .filter((item) => item.origin !== 'body')
      .map((item) => item.url);
    if (fedUrls.length > 0) {
      await markAttachmentsFedToSummary(target.id, fedUrls);
    }
    logger(
      `条目 ${target.id} 摘要完成（${describeDiagnostics(diagnostics)}）`,
    );
    // 索引同步钩子（issue #8）：摘要落库后重刷该条目，摘要文本即刻可被检索；
    // 失败只降级记日志，由重建任务兜底，不影响摘要主管线
    try {
      await syncNoticesToSearchIndex([target.id], logger);
    } catch (error) {
      logger(
        `条目 ${target.id} 检索索引同步失败（由重建任务兜底）：${errorMessage(error)}`,
      );
    }
    return { outcome: 'done', tier, fedCjk: draftChars, error: null };
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
    // 摘要失败告警（issue #12）：先把"转人工复核"落库，再交给调用方决定要不要发信
    await deps.onRetriesExhausted?.({ target, error: message });
    logger(
      `条目 ${target.id} 摘要失败：已重试 ${MAX_RETRIES} 次仍失败，转人工复核（最后错误：${message}）`,
    );
    return { outcome: 'failed_review', tier, fedCjk: draftChars, error: message };
  }
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
      /**
       * 单条的完整链路（取条文 → 重试调用 → 归一化 → 造改动表 → 落库 → 标附件 → 刷索引）
       * 全在 `summarizeOneNotice` 里，与 `scripts/summarize-now.mjs` 是**同一份实现**。
       * 这一层只剩"跑哪几条"与四个汇总计数。
       *
       * 抽出来之前，`fedCount` / `deepCount` 是在调用**之前**加的，现在改成按返回值加：
       * 两者唯一的差别只在"调用抛错"那一种情形 —— 而那种情形下这个函数会一路冒到
       * 任务级、最后那行汇总日志根本不会打，所以对观察者没有任何区别。
       */
      const result = await summarizeOneNotice(target, {
        llm,
        model,
        logger: ctx.logger,
        // 告警的**顺序**与位置都与抽出来之前一字不差（置失败态 → 发警 → 打日志），
        // 只是从共用实现里挪到这个钩子里 —— 理由见 `SummarizeOneNoticeDeps` 的注释：
        // 工具的失败不该顶着 `summarize-notices` 这个任务名去占掉当日那封告警。
        onRetriesExhausted: async ({ target: failed, error }) => {
          await sendTaskFailureAlert({
            jobName: 'summarize-notices',
            sourceId: failed.sourceId,
            error: `条目 ${failed.id} 摘要重试耗尽转人工复核：${error}`,
            now: ctx.now(),
            log: ctx.logger,
          });
        },
      });
      if (result.fedCjk > 0) fedCount += 1;
      if (result.tier === 'deep') deepCount += 1;
      if (result.outcome === 'done') succeeded += 1;
      else sentToReview += 1;
    }
    ctx.logger(
      `摘要任务完成：成功 ${succeeded} 条，转人工复核 ${sentToReview} 条（本轮用到附件条文输入的条目 ${fedCount} 条，其中重档 ${deepCount} 条；附件输入档位 ${attachmentMode()}）`,
    );
  },
};
