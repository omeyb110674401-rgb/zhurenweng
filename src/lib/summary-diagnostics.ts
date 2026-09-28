/**
 * 摘要调用的诊断（issue #86 第 0 刀）——「模型到底吐了什么、我们丢了什么、丢在哪一关」。
 *
 * **为什么必须有它**：删掉的「改动点」连续两轮零产出，而事后**没有任何人能回答**
 * 它是"模型返回了空数组"还是"引用没通过逐字反查被丢掉"——#79 把这句话写进了文档
 * （"两种可能从库里区分不了，定位要拿模型原始输出来看，不该猜"），然后就停在那里。
 * 一个功能可以因为模型不行而失败，也可以因为我们的校验器吃掉产出而失败，
 * 这两件事的处置完全相反（换模型 vs 改校验/改提示词），而**当时库里没有区分它们的信息**。
 * 所以本模块不是"顺手加个日志"：它是这个迭代里每一次提示词改动的**量具**。
 *
 * **它是什么**：`notices.summary_diagnostics_json` 里的一份 JSON，描述**产出当前这一列
 * 摘要的那一次调用**。语义上它与 `ai_summary_json` 是一对：
 * - 摘要任务落库时两者一起写；
 * - 人工复核手工录入时**清空**它（那份摘要是人写的，没有调用可描述）；
 * - 重跑前清空摘要时一起清掉（在 `clearSummaryForRedraft` 的返回值里带出去，备份不丢）。
 *
 * **为什么是独立的列而不是塞进 `ai_summary_json`**（三条，都踩过）：
 * 1. `ai_summary_json` 是**渲染契约**（`parseQuotedSummary` 的形状），往里加键就要同时改读侧，
 *    而读侧一旦判形状异常，存量条目会从「有摘要」掉回「待人工复核」占位（#85 第三节）；
 * 2. 诊断字段会随迭代增删，让它去牵动渲染契约是本末倒置；
 * 3. 这是一列"可以在不影响任何页面时被清空/裁剪"的运维数据，独立性本身有价值。
 *
 * **原始输出为什么要留着**：计数能回答"丢了几条"，回答不了"模型写的是什么"。
 * 后者才是改提示词的依据。截断到 `RAW_OUTPUT_KEEP_CHARS`（实测一次摘要输出在数 KB 量级，
 * 这个上限只挡异常），并且 `rawChars` 记的是**未截断的真值**，所以"它其实更长"这件事查得到。
 */

/** 形状版本：字段增删时 +1，读侧据此判断能不能按当前口径解读。 */
export const SUMMARY_DIAGNOSTICS_VERSION = 1;

/**
 * 原始输出的留存上限（字符）。
 * 不设上限的话，一次跑飞的模型可以把一整篇东西灌进库；设得太小又会在真要定位时被截掉主语。
 * 20,000 字远大于正常输出（数 KB），只挡异常。
 */
export const RAW_OUTPUT_KEEP_CHARS = 20_000;

/** 三类数组字段的条数（模型吐出 / 归一化 / 真的落库，三个阶段各记一次）。 */
export interface SummaryFieldCounts {
  keyPoints: number;
  explanationPoints: number;
  channels: number;
}

/**
 * 丢弃计数，按**死在哪一关**分类。
 *
 * 刻意只分三类，而且每一类都对应一种明确的处置：
 * - `emptyOrInvalid`：条目缺必填文本或类型不对 ⇒ **提示词的字段说明**有问题；
 * - `overLimit`：超过条数上限 ⇒ 上限该调，或模型在凑数（两者的区分看 `emitted` 有多大）；
 * - `quoteNotFound`：引用在本轮喂进去的正文/说明里找不到 ⇒ **三种可能**：模型改写了原文、
 *   模型从没被喂进去的那一截里抄的、或我们的校验器太严（#86 第二节的两条根因候选就在这里）。
 * 前两类在归一化阶段产生（`normalizeModelSummary`），第三类在反查阶段产生
 * （`buildQuotedSummaryWithTally`）—— 分类与产生位置一一对应，不合并成一句"丢了几条"。
 *
 * **一条可核对的等式**（两个要点字段成立，渠道不成立）：
 * `emitted - normalized === emptyOrInvalid + overLimit`，`normalized - kept === quoteNotFound`。
 * 渠道的差额是**去重与条数截断**（`normalizeChannels`），那是设计行为、不是丢内容，
 * 所以刻意不为它编一个"丢弃"计数 —— 一条不成立的等式比没有等式更坏。
 */
export interface SummaryDroppedCounts {
  emptyOrInvalid: number;
  overLimit: number;
  quoteNotFound: number;
}

/** token 用量（网关不给就是 null，三个字段分别记，不编一个总数出来）。 */
export interface SummaryTokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface SummaryDiagnostics {
  v: number;
  model: string;
  provider: string;
  /**
   * 适配器上报的**这一次调用**的耗时（毫秒）。`null` = 端口没有上报
   * （见 `instrumented`），不是"耗时 0 毫秒"—— 两者差别很大，不能混。
   */
  elapsedMs: number | null;
  /** 本条目一共调了几次（含重试）——重试此前只存在于 stdout 里，事后查不到 */
  attempts: number;
  /**
   * 适配器是否报告了响应细节。
   *
   * **为什么必须有这个布尔**：`raw: ''` + `finishReason: null` 有两种截然不同的来路 ——
   * "响应回来了但没有 content"（真故障）与"这个端口根本不产出诊断"（stub / 未上报）。
   * 少了它，读的人会把"没人看过"当成"模型什么都没说"，而这**正是本模块存在的理由**
   * （键在不在 vs 值是多少，同 #82 那次误报）。
   */
  instrumented: boolean;
  /** 模型声明的结束原因（stop / length / content_filter…），拿不到为 null */
  finishReason: string | null;
  usage: SummaryTokenUsage | null;
  /** 响应正文的**未截断**字符数 */
  rawChars: number;
  /** 响应正文（正常时是模型输出；非 2xx 时是错误响应体，`finishReason` 为 null） */
  raw: string;
  rawTruncated: boolean;
  /** 模型吐出的条数（原始 JSON 里的数组长度，未受任何上限影响） */
  emitted: SummaryFieldCounts;
  /** 过了归一化的条数（受条数上限与空值过滤影响，见 `dropped` 的前两类） */
  normalized: SummaryFieldCounts;
  /** 真的落库的条数（再过一道逐字反查，见 `dropped.quoteNotFound`） */
  kept: SummaryFieldCounts;
  dropped: SummaryDroppedCounts;
}

export function emptyFieldCounts(): SummaryFieldCounts {
  return { keyPoints: 0, explanationPoints: 0, channels: 0 };
}

export function emptyDroppedCounts(): SummaryDroppedCounts {
  return { emptyOrInvalid: 0, overLimit: 0, quoteNotFound: 0 };
}

/** 截断原始输出：返回值同时给出"截没截"，因为只留一个被截过的串会让人以为那就是全部。 */
export function capRawOutput(content: string): { raw: string; rawTruncated: boolean } {
  if (content.length <= RAW_OUTPUT_KEEP_CHARS) {
    return { raw: content, rawTruncated: false };
  }
  return { raw: content.slice(0, RAW_OUTPUT_KEEP_CHARS), rawTruncated: true };
}

/**
 * 适配器在**拿到响应之后**才失败时抛的错，错误本身带着已经能算出来的诊断。
 *
 * 为什么要它：失败恰恰是最需要原始输出的场合（"模型输出不是合法 JSON"、"必填段不合格"
 * 这两条今天只留下一句 200 字符以内的错误摘要）。抛错路径不能像成功路径那样把诊断挂在
 * 返回值上，所以只能挂在错误上。
 */
export class LlmResponseError extends Error {
  readonly diagnostics: SummaryDiagnostics;

  constructor(message: string, diagnostics: SummaryDiagnostics) {
    super(message);
    this.name = 'LlmResponseError';
    this.diagnostics = diagnostics;
  }
}

/** 从任意抛出物里取诊断；不是 `LlmResponseError`（或形状不对）返回 null。 */
export function diagnosticsOfError(error: unknown): SummaryDiagnostics | null {
  if (error instanceof LlmResponseError) return error.diagnostics;
  // 跨模块边界（不同 realm / 被包装过一次）时不认 instanceof，按形状认
  if (typeof error === 'object' && error !== null) {
    const candidate = (error as { diagnostics?: unknown }).diagnostics;
    if (candidate !== undefined && candidate !== null) return parseSummaryDiagnostics(candidate);
  }
  return null;
}

/** 可缺的数值：给了有限数就用，否则 null（不把"没上报"写成 0）。 */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function countOr(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function fieldCountsOr(value: unknown): SummaryFieldCounts {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    keyPoints: countOr(record.keyPoints),
    explanationPoints: countOr(record.explanationPoints),
    channels: countOr(record.channels),
  };
}

/**
 * 读侧解析（审计脚本与后台用）：**形状不认识就返回 null，绝不抛错**。
 *
 * 与 `parseQuotedSummary` 同一条纪律：这一列是给人查问题用的，
 * 它自己坏掉不该把查问题的人挡在门外，更不该影响任何页面的渲染。
 */
export function parseSummaryDiagnostics(value: unknown): SummaryDiagnostics | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const version = record.v;
  if (typeof version !== 'number' || !Number.isFinite(version)) return null;

  const usageRaw = record.usage;
  const usage =
    typeof usageRaw === 'object' && usageRaw !== null
      ? (() => {
          const item = usageRaw as Record<string, unknown>;
          const pick = (key: string): number | null =>
            typeof item[key] === 'number' && Number.isFinite(item[key]) ? (item[key] as number) : null;
          return { promptTokens: pick('promptTokens'), completionTokens: pick('completionTokens'), totalTokens: pick('totalTokens') };
        })()
      : null;

  return {
    v: version,
    model: typeof record.model === 'string' ? record.model : '',
    provider: typeof record.provider === 'string' ? record.provider : '',
    elapsedMs: numberOrNull(record.elapsedMs),
    attempts: countOr(record.attempts),
    instrumented: record.instrumented === true,
    finishReason: typeof record.finishReason === 'string' ? record.finishReason : null,
    usage,
    rawChars: countOr(record.rawChars),
    raw: typeof record.raw === 'string' ? record.raw : '',
    rawTruncated: record.rawTruncated === true,
    emitted: fieldCountsOr(record.emitted),
    normalized: fieldCountsOr(record.normalized),
    kept: fieldCountsOr(record.kept),
    dropped: (() => {
      const raw = (typeof record.dropped === 'object' && record.dropped !== null ? record.dropped : {}) as Record<string, unknown>;
      return {
        emptyOrInvalid: countOr(raw.emptyOrInvalid),
        overLimit: countOr(raw.overLimit),
        quoteNotFound: countOr(raw.quoteNotFound),
      };
    })(),
  };
}

/**
 * 把「端口上报的诊断（可能没有）」与「worker 才知道的那几个字段」合成一份完整诊断。
 *
 * 分工是有边界的，别互相覆盖：
 * - 端口管**响应**：耗时、结束原因、token、原始正文、模型吐了几条、归一化阶段丢了几条；
 * - worker 管**这条目的调用过程与结果**：试了几次、最终落库几条、反查阶段丢了几条、
 *   以及模型与端口名（它本来就要算这个给日志用）。
 *
 * 端口没上报时（stub、或将来某个不产出诊断的实现）返回的对象 `instrumented: false`，
 * 响应类字段一律为空 —— **不编造**。诊断里最坏的情况不是字段少，是让人以为有人看过。
 */
export function buildSummaryDiagnostics(
  reported: SummaryDiagnostics | undefined,
  overrides: {
    model: string;
    provider: string;
    attempts: number;
    kept: SummaryFieldCounts;
    quoteNotFound: number;
  },
): SummaryDiagnostics {
  const base: SummaryDiagnostics = reported ?? {
    v: SUMMARY_DIAGNOSTICS_VERSION,
    model: '',
    provider: '',
    elapsedMs: null,
    attempts: 0,
    instrumented: false,
    finishReason: null,
    usage: null,
    rawChars: 0,
    raw: '',
    rawTruncated: false,
    emitted: emptyFieldCounts(),
    normalized: emptyFieldCounts(),
    kept: emptyFieldCounts(),
    dropped: emptyDroppedCounts(),
  };
  return {
    ...base,
    model: overrides.model,
    provider: overrides.provider,
    attempts: overrides.attempts,
    kept: overrides.kept,
    dropped: { ...base.dropped, quoteNotFound: overrides.quoteNotFound },
  };
}

/** 一行中文摘要（审计脚本、后台、日志共用同一份口径，免得三处各写一遍）。 */
export function describeDiagnostics(diagnostics: SummaryDiagnostics): string {
  const emitted = diagnostics.emitted;
  const kept = diagnostics.kept;
  const dropped = diagnostics.dropped;
  const lost = dropped.emptyOrInvalid + dropped.overLimit + dropped.quoteNotFound;
  const parts = [
    `${diagnostics.model || '未知模型'}${diagnostics.elapsedMs === null ? '' : ` ${(diagnostics.elapsedMs / 1000).toFixed(1)}s`}`,
  ];
  if (diagnostics.instrumented) {
    parts.push(`条文要点 ${kept.keyPoints}/${emitted.keyPoints}`);
    parts.push(`说明要点 ${kept.explanationPoints}/${emitted.explanationPoints}`);
  } else {
    // 端口没上报时**不写分母**：那个数现在谁都不知道，写成 `3/0` 会被读成"模型吐了 0 条"，
    // 而这两个事实处置相反（一个是模型的问题，一个是没量具）
    parts.push(`落库条文要点 ${kept.keyPoints} 条 / 说明要点 ${kept.explanationPoints} 条`);
    parts.push('端口未上报响应细节（只有落库条数可信）');
  }
  if (lost > 0) {
    parts.push(
      `丢弃 ${lost}（反查不到出处 ${dropped.quoteNotFound} / 空或类型不对 ${dropped.emptyOrInvalid} / 超上限 ${dropped.overLimit}）`,
    );
  }
  if (diagnostics.attempts > 1) parts.push(`重试后第 ${diagnostics.attempts} 次成功`);
  if (diagnostics.finishReason !== null && diagnostics.finishReason !== 'stop') {
    parts.push(`结束原因 ${diagnostics.finishReason}`);
  }
  if (diagnostics.rawTruncated) parts.push(`原始输出已截断（原 ${diagnostics.rawChars} 字）`);
  return parts.join('；');
}
