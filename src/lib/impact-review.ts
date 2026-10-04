import { quoteFingerprint, type QuotedImpactPoint } from './summary-content.ts';

/**
 * 审读记录（`notices.impact_review_json`）的形状、读侧容错与匹配（issue #47，
 * 决定台账见 `docs/pending-issues/91-l3-compliance-review-gate.md` 第八节第 6、19 条）。
 *
 * ## 它是什么
 *
 * 一条记录 = **一路独立模型对某一条判读的合规性结论**（通过 / 已改 / 剔除），
 * 术语见根级 `CONTEXT.md`（那里「审读」与「人工复核」正式分家）。
 *
 * ## 为什么独立落、不进 `ai_summary_json`
 *
 * 那一列是**渲染契约**：往里加键就要同时改读侧，而读侧一旦判形状异常，存量条目会从
 * 「有摘要」掉回「待人工复核」占位（#85 的教训）。审读层还必须是**可抛弃的** ——
 * 生成侧重跑之后旧的审读结论一律失效（硬约束 7），所以它需要一个能独立清空、独立裁剪、
 * 坏掉也不牵动任何页面的落点。先例是 `summary_diagnostics_json`（#86 第 0 刀）。
 *
 * ## 靠什么 join：内容指纹全等（第 19 条）
 *
 * `(quote 指纹, text 指纹)` **两个都全等**才算这份记录属于这条判读。指纹直接复用生成侧
 * 反查用的 `quoteFingerprint`（引号字形归一 + 去全部空白 + 去包裹引号）——**不新立一把尺子**：
 * 两份归一化各写一份的后果是"同一句原文在两处判定不同"，而那种偏差看起来像模型写错了。
 *
 * 三个后果，都是这一条决定的：
 * - **生成侧重跑 ⇒ 自动失效**：`text` 变了指纹就对不上 ⇒ 该条判读退回"没有有效记录"。
 *   于是"重跑后不会出现没被审读过的文本配着别人的审读结论"是纯函数可测的行为，
 *   不必为时序语义另立一层测试。
 * - **内容一字未变 ⇒ 幂等有效**：同一份内容、同一份结论，重跑一次不需要重新审读。
 * - **判读不迁表**：逐条生命周期由这一列承担，不引入"稳定 id"、不把 L3 搬到条款级表
 *   （86 的触发条件由此满足，而在判据被验证之前不锁死存储形状 —— 第 1 条）。
 *
 * ## 指纹为什么是"归一化后的内容"而不是哈希
 *
 * 三个理由，按重要性排：
 * ① **量具与页面同源**：`deploy/audit-l3-reach.sql` 的"能不能渲染"要在库里复核同一条判据，
 *    而 SQL 里能做的只有 `regexp_replace` 那一步归一 —— 哈希它算不出来。指纹若是哈希，
 *    审计脚本就只能另立一套近似判据，而"量具与页面各说各话"正是本项目反复栽的那类缺口。
 * ② 归一化键是**人可读的**：一条记录自己就能说明它审的是哪一句，审计不必反解。
 * ③ 不引入 `node:crypto`：这个模块在客户端组件链上也可能被引用，而哈希只多了一层
 *    没有可核对性的间接。
 *
 * 代价是这一列比存哈希大一些（每条记录多一份归一化后的引用与推断正文）——判读一共
 * 几十条，这点体积换"审计能自己复算"是划算的。
 */

/** 单条判读的审读结论，取值互斥（`CONTEXT.md`「审读状态」）。 */
export type ImpactReviewStatus = 'passed' | 'revised' | 'rejected';

/**
 * 这一轮审读**跑成什么样**（issue #50）。
 *
 * 为什么必须分这么细：`status` 全落在"这一批判读有没有审读记录"上（门翻转之后 = 渲不渲染），
 * 而下面这几种的**处置完全相反**：
 * - `not-configured` / `not-independent` ⇒ **配置问题**（运维的活）；
 * - `port-error` ⇒ 端口构造失败（配置或代码，看错误）；
 * - `timeout` / `request-failed` ⇒ 网络或服务商（重试/换端点）；
 * - `invalid-shape` ⇒ 模型没按形状回话（提示词的活）；
 * - `ok` ⇒ 跑了，`accepted / rejected` 说明采信了几条。
 *
 * 少了这个区分，"这一条判读为什么没有记录"在库里只有一种读法 —— 而它今天至少有六种原因。
 */
export type ReviewOutcome =
  | 'ok'
  | 'skipped'
  | 'not-configured'
  | 'not-independent'
  | 'port-error'
  | 'timeout'
  | 'request-failed'
  | 'invalid-shape';

/** 全部取值（白名单：诊断读侧靠它判断这一格能不能解读，认不出就整份丢掉）。 */
export const REVIEW_OUTCOMES: readonly ReviewOutcome[] = [
  'ok',
  'skipped',
  'not-configured',
  'not-independent',
  'port-error',
  'timeout',
  'request-failed',
  'invalid-shape',
];

export function isReviewOutcome(value: unknown): value is ReviewOutcome {
  return typeof value === 'string' && (REVIEW_OUTCOMES as readonly string[]).includes(value);
}

/** 诊断那一行的中文说法（**只在诊断与审计面**可见，页面上一个字都不许出现）。 */
export const REVIEW_OUTCOME_LABELS: Record<ReviewOutcome, string> = {
  ok: '通过',
  skipped: '跳过（这条没有判读可审）',
  'not-configured': '未配置',
  'not-independent': '独立性不成立',
  'port-error': '端口构造失败',
  timeout: '超时',
  'request-failed': '调用失败',
  'invalid-shape': '返回形状非法',
};

/** 端口没配好（缺 key / 缺 base / 缺 model / 端点不是合法 URL）—— 构造期就能发现的那一类。 */
export class ImpactReviewConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImpactReviewConfigError';
  }
}

/** 调用没跑成：`timeout` / `http` / `network` 三种，**都不是模型的错**。 */
export class ImpactReviewTransportError extends Error {
  readonly kind: 'timeout' | 'http' | 'network';
  /** 响应体（HTTP 错误时才有；已截断），诊断与日志用 */
  readonly raw: string;
  readonly elapsedMs: number | null;

  constructor(
    message: string,
    kind: 'timeout' | 'http' | 'network',
    options: { raw?: string; elapsedMs?: number | null } = {},
  ) {
    super(message);
    this.name = 'ImpactReviewTransportError';
    this.kind = kind;
    this.raw = options.raw ?? '';
    this.elapsedMs = options.elapsedMs ?? null;
  }
}

/** 跑成了，但响应不是我们能读的形状（不是 JSON 数组 / 状态认不出）。 */
export class ImpactReviewShapeError extends Error {
  /** 模型原始输出（已截断），诊断里要能看见它到底说了什么 */
  readonly raw: string;
  readonly elapsedMs: number | null;

  constructor(message: string, raw: string, elapsedMs: number | null = null) {
    super(message);
    this.name = 'ImpactReviewShapeError';
    this.raw = raw;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * 失败时能拿到的模型原始输出（形状非法这类失败最需要它；拿不到返回空串）。
 *
 * 形态识别而非 `instanceof`：跨 realm（不同模块实例）时不认类，而**这类失败恰恰是
 * 最需要诊断的场合**，不能因为一个 `instanceof` 判否就把原始输出丢掉。
 */
export function reviewFailureRaw(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const raw = (error as { raw?: unknown }).raw;
  return typeof raw === 'string' ? raw : '';
}

/**
 * 把抛出来的东西归到 `ReviewOutcome` 上（诊断写这一格）。
 *
 * **认不出的一律归 `request-failed`**（而不是编一个"未知"档）：它至少把"调用没成"这件事
 * 说清楚了，而"未知"会让读的人以为是某条新路径。跨 realm 时不认 `instanceof`，按 `name` 认
 * （与 `diagnosticsOfError` 同一手法）。
 */
export function reviewOutcomeOfError(error: unknown): ReviewOutcome {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : null;
  if (name === 'ImpactReviewConfigError') return 'port-error';
  if (name === 'ImpactReviewShapeError') return 'invalid-shape';
  if (name === 'ImpactReviewTransportError') {
    const kind = (error as { kind?: unknown }).kind;
    return kind === 'timeout' ? 'timeout' : 'request-failed';
  }
  // 超时也可能以平台错误的形式冒出来（`AbortSignal.timeout` → TimeoutError/AbortError）
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  return 'request-failed';
}

/** 全部结论取值（白名单：认不出的值一律不当结论用，见 `parseImpactReviews`）。 */
export const IMPACT_REVIEW_STATUSES: readonly ImpactReviewStatus[] = [
  'passed',
  'revised',
  'rejected',
];

/**
 * 结论的展示名（**只在诊断与审计面**可见 —— 页面上一个字都不许出现，
 * 决定 18：读不出来源的字样不许进读者视野）。
 */
export const IMPACT_REVIEW_STATUS_LABELS: Record<ImpactReviewStatus, string> = {
  passed: '通过',
  revised: '已改',
  rejected: '剔除',
};

/**
 * 一条审读记录。
 *
 * **没有"理由"字段**（PRD「审读记录（存储）」）：本仓对"说不清凭什么"的字段一律不要，
 * 而"改了什么、凭什么改"已由**原文与审读后文本并存**本身可审计 ——
 * 多一个没人必须填的字段只会是空的。
 */
export interface ImpactReviewRecord {
  /**
   * 这一条判读的 `quote` 指纹（`quoteFingerprint(impact.quote)`）。
   * 生成侧与审读侧都用这一把尺子；匹配时由**本仓**从判读现算，不信模型回显。
   */
  quoteFingerprint: string;
  /** 这条判读**生成侧** `text` 的指纹（不是审读后文本的）。 */
  textFingerprint: string;
  status: ImpactReviewStatus;
  /** 审读后文本：**仅「已改」有值**，其余为 null（「已改」没有文本的记录不成立）。 */
  revisedText: string | null;
  /** 审读模型标识（`provider:model`），审计用；读侧缺失也照样认这份记录（见 parse） */
  model: string;
  /** 审读时刻（ISO 8601），审计用 */
  reviewedAt: string;
}

/**
 * 审读端口对**一条**判读给出的结论。
 *
 * 形状刻意要求模型**逐字回显** `quote` 与 `text`：那正是"只减不加"（硬约束 8）的判据 ——
 * 它想换引用、想新增或删除判读条目，就与本仓手里的判读对不上号，于是**没有记录**
 * （`impactReviewRecordsFrom`）。这也让"模型有没有偷偷改引用"变成可数的东西，而不是靠信它。
 */
export interface ImpactReviewVerdict {
  /** 它审的那条判读的逐字引用（必须与生成侧**指纹全等**） */
  quote: string;
  /** 它审的那条判读的推断正文（必须与生成侧**指纹全等**） */
  text: string;
  status: ImpactReviewStatus;
  /** 仅「已改」：审读后文本。其余状态下给了也不采信。 */
  revisedText?: string | null;
}

/** 匹配键：两个指纹拼在一起，用 NUL 分隔（指纹是任意文本，必须有一个不可能出现的分隔符）。 */
export function impactReviewKey(quote: string, text: string): string {
  return `${quoteFingerprint(quote)}\u0000${quoteFingerprint(text)}`;
}

export function isImpactReviewStatus(value: unknown): value is ImpactReviewStatus {
  return typeof value === 'string' && (IMPACT_REVIEW_STATUSES as readonly string[]).includes(value);
}

/** 一条记录的读侧校验：**判据字段严格、审计字段宽容**（理由见 `parseImpactReviews`）。 */
function recordFrom(value: unknown): ImpactReviewRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const quote = typeof row.quoteFingerprint === 'string' ? row.quoteFingerprint : '';
  const text = typeof row.textFingerprint === 'string' ? row.textFingerprint : '';
  // 空指纹一律不认：任何一条判读现算出来的 `quote` 指纹都不为空的（`quote` 过不了反查就
  // 根本不落库），所以空指纹是一条**匹配不上任何东西**的记录 —— 留着它只会让
  // "这一列有几条记录"这个数说谎。
  if (quote === '' || text === '') return null;
  if (!isImpactReviewStatus(row.status)) return null;
  const status = row.status;
  const revised = typeof row.revisedText === 'string' ? row.revisedText : '';
  // 「已改」而没有文本 ⇒ 这份记录**不成立**（没有可渲染的那一份）。它不是"通过"、
  // 也不是"剔除"：宁可不认，也不猜它想说什么（fail-closed 的同一条纪律）。
  if (status === 'revised' && revised.trim() === '') return null;
  return {
    quoteFingerprint: quote,
    textFingerprint: text,
    status,
    revisedText: status === 'revised' ? revised : null,
    model: typeof row.model === 'string' ? row.model : '',
    reviewedAt: typeof row.reviewedAt === 'string' ? row.reviewedAt : '',
  };
}

/**
 * 读侧解析（列值 → 记录数组）。认不出形状的一律丢掉，**绝不抛错**：一列坏数据
 * 不该让整页渲染不出来（与 `parseStoredImpacts` / `parseSummaryDiagnostics` 同规矩）。
 *
 * 两个刻意的宽容：
 * - 入参可以是**未解析的 JSON 字符串**（列值原样，或 `safeParseJson` 之后的值都可以）；
 * - `model` / `reviewedAt` 缺失或不是字符串 ⇒ 补空串，**不影响这份记录是否被采信** ——
 *   它们是审计字段，而"审计字段不全"与"这条判读该不该渲染"是两件事；
 *   判据字段（两个指纹 + 状态 + 已改文本）则一项都不许缺。
 */
export function parseImpactReviews(value: unknown): ImpactReviewRecord[] {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const records: ImpactReviewRecord[] = [];
  for (const item of raw) {
    const record = recordFrom(item);
    if (record !== null) records.push(record);
  }
  return records;
}

/**
 * 写侧序列化：**一条记录都没有 ⇒ null**（不是 `'[]'`）。
 *
 * 为什么：这一列的可空与"有没有审读"是同一件事的另一面（清空、重跑、从没跑过都该是 NULL）。
 * 写一个空数组进去会让 `is not null` 这个最常用的核对判据说谎 ——
 * 而审计脚本、回填脚本、量具都靠它判"这一条跑过审读没有"。
 */
export function serializeImpactReviews(
  records: readonly ImpactReviewRecord[],
): string | null {
  return records.length === 0 ? null : JSON.stringify(records);
}

/**
 * 端口的结论 → 审读记录（**只减不加**的落地点，硬约束 8）。
 *
 * 规则（每一条都对应一个已拍板的决定）：
 * - 只有**逐字回显同一对 (quote, text)** 的结论才被接受。想换引用 / 想说别的条目 ⇒
 *   在 `impacts` 里找不到那一对 ⇒ 那条结论直接丢掉。
 * - 同一条判读收到**两份结论** ⇒ 那一对**整份不采信**。"歧义"比"缺记录"坏得多：
 *   缺记录的表现是这条不渲染（看得见），错挂的表现是读者读到一份没人做过的结论（看不见）。
 * - 「已改」没有文本 ⇒ 不采信（与读侧同一条）。
 * - 记录的键**由本仓从判读现算**，永不采用模型回显的字符串 —— 回显只用来配对，
 *   不当存储值。这样"指纹是谁算的"只有一个答案。
 * - 端口对某条判读**一句话没说** ⇒ 那条**没有记录**（不补"通过"：没被审读过的文本
 *   不许因为沉默而被放行）。
 *
 * 返回值只含"有记录"的那些判读，顺序与 `impacts` 一致（诊断面可读）。
 */
export function impactReviewRecordsFrom(input: {
  impacts: readonly QuotedImpactPoint[];
  verdicts: readonly ImpactReviewVerdict[];
  /** 审读模型标识（审计用，原样落库） */
  model: string;
  /** 审读时刻（ISO 8601，原样落库） */
  reviewedAt: string;
}): ImpactReviewRecord[] {
  /** 键 → 结论；同一个键第二次出现置 null（歧义 ⇒ 整份不采信） */
  const byKey = new Map<string, ImpactReviewVerdict | null>();
  for (const verdict of input.verdicts) {
    if (typeof verdict?.quote !== 'string' || typeof verdict?.text !== 'string') continue;
    if (!isImpactReviewStatus(verdict.status)) continue;
    const key = impactReviewKey(verdict.quote, verdict.text);
    byKey.set(key, byKey.has(key) ? null : verdict);
  }

  const records: ImpactReviewRecord[] = [];
  for (const impact of input.impacts) {
    const verdict = byKey.get(impactReviewKey(impact.quote, impact.text));
    if (verdict === undefined || verdict === null) continue;
    const revised = typeof verdict.revisedText === 'string' ? verdict.revisedText : '';
    if (verdict.status === 'revised' && revised.trim() === '') continue;
    records.push({
      quoteFingerprint: quoteFingerprint(impact.quote),
      textFingerprint: quoteFingerprint(impact.text),
      status: verdict.status,
      revisedText: verdict.status === 'revised' ? revised : null,
      model: input.model,
      reviewedAt: input.reviewedAt,
    });
  }
  return records;
}

/**
 * 这条判读的那一份记录：`quote` 与 `text` **两个指纹都全等**才算数（第 19 条）。
 *
 * 由**本仓**从判读现算指纹（不信任何已存字段）：生成侧重跑改了 `text` ⇒ 对不上 ⇒
 * 这份旧结论自动失效。没有匹配 ⇒ null（调用方按"没有有效记录"处置）。
 */
export function findImpactReview(
  records: readonly ImpactReviewRecord[],
  impact: Pick<QuotedImpactPoint, 'quote' | 'text'>,
): ImpactReviewRecord | null {
  const quote = quoteFingerprint(impact.quote);
  const text = quoteFingerprint(impact.text);
  for (const record of records) {
    if (record.quoteFingerprint === quote && record.textFingerprint === text) return record;
  }
  return null;
}

/**
 * 一批判读被审读覆盖到什么程度（issue #51 的回填要靠它核"缺口为 0"）。
 *
 * **判据与渲染门共用同一个 `findImpactReview`**：覆盖与否就是"门认不认这份记录"。
 * 两处各判一份的表现是 —— 量具说覆盖了、门却把它当无记录，而那正是本仓反复栽的
 * "量具与页面各说各话"。
 *
 * `missing` 给的是**缺口本身**（引用 + 推断正文），不是一个数：回填要点名跑哪几条、
 * 事后核对也要能逐条对上。
 */
export interface ImpactReviewCoverage {
  /** 这一批判读共几条 */
  total: number;
  /** 有有效记录的条数 */
  covered: number;
  /** 没有有效记录的那些（逐条给出引用与推断正文） */
  missing: { quote: string; text: string }[];
  /** 有效记录按结论分布（通过 / 已改 / 剔除） */
  statuses: Record<ImpactReviewStatus, number>;
}

export function impactReviewCoverage(
  impacts: readonly QuotedImpactPoint[],
  records: readonly ImpactReviewRecord[],
): ImpactReviewCoverage {
  const statuses: Record<ImpactReviewStatus, number> = { passed: 0, revised: 0, rejected: 0 };
  const missing: { quote: string; text: string }[] = [];
  let covered = 0;
  for (const impact of impacts) {
    const record = findImpactReview(records, impact);
    if (record === null) {
      missing.push({ quote: impact.quote, text: impact.text });
      continue;
    }
    covered += 1;
    statuses[record.status] += 1;
  }
  return { total: impacts.length, covered, missing, statuses };
}
