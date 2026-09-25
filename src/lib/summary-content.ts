import type { LlmPort, StructuredSummary, SummaryChannel, SummaryChannelKind } from './ports.ts';
import type { ChangeKind, ChangeMarkerCount } from './amendment-coverage.ts';

/**
 * AI 摘要的领域形状（issue #4 建立，issue #55 重构为「参与导引」口径）——
 * worker 落库（notices.ai_summary_json / summary_status）与详情页渲染共用；
 * 与具体 LLM 服务商解耦。
 *
 * 形状上的一条硬道理：**每段都必须能对上原文的逐字片段**（PRD 的「引用可核对」）。
 * `LlmPort.summarize()` 的返回类型保持 ports.ts 里的扁平 `StructuredSummary`
 * （该文件是并行切片共享的接缝，不做结构改动）；原文引用由适配器以可选的 `quotes`
 * 扩展属性携带（见 `QuotedStructuredSummary`），摘要任务统一归一化为 `QuotedSummary`
 * 落库 —— 不返回 quotes 的适配器（或某字段缺引用）落库为 quote = null，
 * 详情页对该段隐藏引用块。
 *
 * 段的**必填 / 可缺**之分是有意的：`what` / `who` / `howToComment` 三段任何一份公示
 * 都答得出（缺了就是模型没答上，应当重试）；`whoCanSubmit` / `afterDeadline` 取决于
 * 公告有没有写，强要就会逼模型编，所以允许为空并且空段不渲染。
 * `keyPoints` 是历史字段：新输出不再生成（公告壳里没有条款可概括，见 ports.ts 的说明），
 * 但**存量摘要在重刷完成前仍带着它**，所以解析与渲染都保留一条通路。
 */

/** 摘要状态（notices.summary_status） */
export type SummaryStatus = 'pending' | 'done' | 'failed_review';

/**
 * 摘要状态标签（`SummaryPlaceholder` 用）。
 *
 * 这**不是**「摘要区该显示什么」的判据 —— 那在 `summary-display.ts`
 * （issue #58）：本表只是 `summary_status` 的中文名字，管不到「已截止的条目根本
 * 不会入队」这类页面级事实。把标签表当真相来源，就等于对着永不生成的小队说「生成中」。
 */
export const SUMMARY_STATUS_LABELS: Record<SummaryStatus, string> = {
  pending: '摘要生成中',
  done: '摘要已生成',
  failed_review: '摘要生成中（待人工复核）',
};

/** 渠道类型的展示名（也是后台人工录入时可写的中文前缀） */
export const SUMMARY_CHANNEL_LABELS: Record<SummaryChannelKind, string> = {
  email: '电子邮箱',
  phone: '电话',
  mail: '信函邮寄',
  online: '在线提交',
  other: '其他方式',
};

const CHANNEL_KINDS = Object.keys(SUMMARY_CHANNEL_LABELS) as SummaryChannelKind[];

/** 渠道类型白名单（模型输出归一化用；标签与白名单必须同源，故在此导出） */
export const SUMMARY_CHANNEL_KINDS: readonly SummaryChannelKind[] = CHANNEL_KINDS;

/** 渠道条数上限：政府公示常见的邮件 / 信函 / 传真 / 网址四种已够用，多余视为模型跑偏 */
const MAX_CHANNELS = 8;

/** 单个摘要段落：摘要文本 + 原文引用片段（quote 为官方原文中的原句摘录） */
export interface SummarySection {
  text: string;
  quote: string | null;
}

/** 截止日期段落：原文未提及时 text 为 null */
export interface SummaryDeadlineSection {
  text: string | null;
  quote: string | null;
}

/** 一条提交渠道 + 它在原文里对应的片段 */
export interface QuotedSummaryChannel extends SummaryChannel {
  quote: string | null;
}

/**
 * 一条草案条文要点（issue #57 第 6 步）。
 *
 * 与普通段落多出的两个字段是**出处**：`source` 是这条要点的引用被反查到的那个附件文件名。
 * 出处由程序算，不由模型报 —— 模型会把两份附件的内容混标到其中一份上，而读者从页面上
 * 看不出这种错配，只会以为是我们编的。反查不到的一律不落库（见 `buildQuotedSummary`），
 * 所以 `source` 为 null 只有一种来路：**改动前落库的旧格式摘要**，页面会明写「未标出处」。
 */
export interface QuotedDraftPoint extends SummarySection {
  source: string | null;
  sourceUrl: string | null;
}

/**
 * 一处修正案改动点（issue #76 第 2 刀）。
 *
 * `quote` 是**逐字原文**且必须能在本轮喂进去的条文里反查到 —— 反查不到就整条丢弃
 * （见 `buildQuotedSummary`），所以页面上每行改动都对应本站真读到的一句话。
 * `clause` / `kind` / `text` 是模型对着那句话写下的说明：它们本身不可逐字核对，
 * 因此页面把三者与出处排在一起给读者对照，而不是让说明脱离原文单独成立。
 */
export interface QuotedAmendmentChange {
  /** 被改条款标识（照抄原文写法） */
  clause: string;
  kind: ChangeKind;
  /** 一句话说明（≤40 字） */
  text: string;
  quote: string;
  source: string | null;
  sourceUrl: string | null;
}

/**
 * ai_summary_json 的落库形状。
 */
export interface QuotedSummary {
  what: SummarySection;
  who: SummarySection;
  /** 谁能提（text 为空串 = 公告未提及，渲染时整段不出现） */
  whoCanSubmit: SummarySection;
  /** 逾期会怎样（同上） */
  afterDeadline: SummarySection;
  /** 历史字段（#56 停用）→ 现为**草案条文要点**：只有喂了附件条文才会产生（issue #57 第 5 步） */
  keyPoints: QuotedDraftPoint[];
  /** 修正案改动点（issue #76）：只有体裁判为修正案且引用能逐字反查到才会有内容 */
  changes: QuotedAmendmentChange[];
/** 正文里检测到的改动表述计数：页面那行"共检测到 N 处、本页列出 M 处"的分母 */
  changeMarkers: ChangeMarkerCount | null;
  /** deadline.text 为 ISO 日期（YYYY-MM-DD）或 null */
  deadline: SummaryDeadlineSection;
  howToComment: SummarySection;
  channels: QuotedSummaryChannel[];
}

/** 适配器可选携带的各字段原文引用片段（与 StructuredSummary 字段一一对应） */
export interface SummaryQuotes {
  what?: string | null;
  who?: string | null;
  whoCanSubmit?: string | null;
  afterDeadline?: string | null;
  keyPoints?: (string | null)[];
  deadline?: string | null;
  howToComment?: string | null;
  /** 与 channels 一一对应的原文片段 */
  channels?: (string | null)[];
}

/** LLM 适配器可返回的扩展形状：在 StructuredSummary 之上附带原文引用 */
export interface QuotedStructuredSummary extends StructuredSummary {
  quotes?: SummaryQuotes;
}

/** 单段引用片段的长度上限：超过视为异常输出，丢弃（引用应是短摘录）。 */
const MAX_QUOTE_LENGTH = 300;

/** 清洗引用片段：去首尾空白与包裹引号；空串或超长返回 null。 */
function cleanQuote(quote: string | null | undefined): string | null {
  if (typeof quote !== 'string') return null;
  const trimmed = quote.trim().replace(/^["'「『]|["'」』]$/g, '').trim();
  if (trimmed.length === 0 || trimmed.length > MAX_QUOTE_LENGTH) return null;
  return trimmed;
}

/**
 * 渠道清单的归一化 —— 模型输出、落库回读、后台人工录入**共用这一份**，避免多处
 * 各写一套口径（口径分家的下场见 issue #23/#25：一边放行另一边拒收）。
 *
 * 只接受数组；value 去空去重、按 MAX_CHANNELS 截断；kind 不在白名单内归为 'other'
 * （含中文标签写法，如 `电子邮箱`，人工录入时更顺手）。
 *
 * 引用（quote）有两个来源，且都在**去重/截断之前**按原始下标配好：
 * - `quotesOf[i]`：模型把引用放在与 channels 平行的数组里（与 keyPoints 同一套路）；
 * - 渠道项自带的 `quote`：已落库的 JSON 回读时引用就在项里。
 * 若先归一化再按下标取引用，去重就会让后面的渠道挂上前面的引用。
 */
export function normalizeChannels(
  input: unknown,
  quotesOf?: (string | null)[] | undefined,
): QuotedSummaryChannel[] {
  if (!Array.isArray(input)) return [];
  const labelToKind = new Map<string, SummaryChannelKind>(
    CHANNEL_KINDS.map((kind) => [SUMMARY_CHANNEL_LABELS[kind], kind]),
  );
  const channels: QuotedSummaryChannel[] = [];
  const seen = new Set<string>();
  input.forEach((raw, index) => {
    if (channels.length >= MAX_CHANNELS) return;
    if (typeof raw !== 'object' || raw === null) return;
    const item = raw as Record<string, unknown>;
    const value = typeof item.value === 'string' ? item.value.trim() : '';
    if (value === '' || seen.has(value.toLowerCase())) return;
    const declared = typeof item.kind === 'string' ? item.kind.trim() : '';
    const kind =
      CHANNEL_KINDS.includes(declared as SummaryChannelKind)
        ? (declared as SummaryChannelKind)
        : (labelToKind.get(declared) ?? 'other');
    const quote = cleanQuote(quotesOf?.[index] ?? (typeof item.quote === 'string' ? item.quote : null));
    seen.add(value.toLowerCase());
    channels.push({ kind, value, quote });
  });
  return channels;
}

/**
 * 引用与条文比对用的「指纹」：去掉全部空白与包裹引号。
 *
 * 为什么要去空白：附件抽取出来的文本带 PDF/DOCX 的换行与缩进，模型引用时常把它们压成
 * 一行 —— 按原样 indexOf 会把**真的逐字引用**判成对不上，那种误杀等于让附件白读一遍。
 * 去掉空白只可能让比对**变松**（不会凭空造出匹配），代价是可接受的方向。
 */
function quoteFingerprint(text: string): string {
  return text.replace(/[\s\u3000]+/g, '').replace(/^["'“「『]|["'”」』]$/g, '');
}

/**
 * 短于这个字数的"引用"不构成可核对的出处。
 * 像「第三条」「本办法」这种片段在任何公文里都能蒙中，标它「摘自附件《X》」等于给一句
 * 没有信息量的话盖上"有据可查"的章 —— 宁可丢条目，不标假出处。
 */
const MIN_VERIFIABLE_QUOTE_CHARS = 8;

/** 在给出的条文里反查这条引用的出处；找不到（或太短不可核对）返回 null。 */
export function findDraftSourceForQuote<T extends { name: string; url: string; text: string }>(
  quote: string | null,
  sources: T[] | undefined,
): T | null {
  if (!quote) return null;
  const normalized = quoteFingerprint(quote);
  if (normalized.length < MIN_VERIFIABLE_QUOTE_CHARS) return null;
  for (const source of sources ?? []) {
    if (quoteFingerprint(source.text).includes(normalized)) return source;
  }
  return null;
}

/**
 * 把 LLM 返回的扁平摘要 + 可选引用归一化为落库形状。
 * 字段缺失 / 类型异常时保守兜底，保证落库 JSON 永远符合 QuotedSummary 形状。
 *
 * `draftSources` 是本轮**实际喂给模型的条文**（issue #57 第 5 步）：条文要点必须
 * 用它反查出处。没给这个参数（后台人工录入、影子档）时，模型即使编出了 keyPoints
 * 也会全部丢弃 —— 于是「页面上出现了条文要点」这件事，只有在附件正文真的进了
 * 提示词时才成立，这条不变量不依赖提示词措辞是否被模型遵守。
 */
export function buildQuotedSummary(
  summary: StructuredSummary,
  quotes?: SummaryQuotes,
  draftSources?: { name: string; url: string; text: string }[],
  changeMarkers?: ChangeMarkerCount | null,
): QuotedSummary {
  const rawPoints = Array.isArray(summary.keyPoints) ? summary.keyPoints : [];
  const quotePoints = Array.isArray(quotes?.keyPoints) ? (quotes.keyPoints as (string | null)[]) : [];
  const text = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : '';

  const keyPoints: QuotedDraftPoint[] = [];
  rawPoints.forEach((point, index) => {
    const pointText = text(point);
    if (pointText === '') return;
    const quote = cleanQuote(quotePoints[index]);
    const source = findDraftSourceForQuote(quote, draftSources);
    // 反查不到 ⇒ 这条要点没有可核对的出处（模型改写了原文，或从公告壳里"提炼"出条文）。
    // 丢弃而不是照登：详情页那句「摘自官方原文」不该为一条核对不上的话背书。
    if (source === null) return;
    keyPoints.push({ text: pointText, quote, source: source.name, sourceUrl: source.url });
  });

  return {
    what: { text: text(summary.what), quote: cleanQuote(quotes?.what) },
    who: { text: text(summary.who), quote: cleanQuote(quotes?.who) },
    whoCanSubmit: { text: text(summary.whoCanSubmit), quote: cleanQuote(quotes?.whoCanSubmit) },
    afterDeadline: { text: text(summary.afterDeadline), quote: cleanQuote(quotes?.afterDeadline) },
    keyPoints,
    changes: buildChanges(summary, draftSources),
    changeMarkers: changeMarkers ?? null,
    deadline: {
      text:
        summary.deadline === null || summary.deadline === undefined
          ? null
          : text(summary.deadline) || null,
      quote: cleanQuote(quotes?.deadline),
    },
    howToComment: { text: text(summary.howToComment), quote: cleanQuote(quotes?.howToComment) },
    channels: normalizeChannels(summary.channels, quotes?.channels),
  };
}

/**
 * 逐条反查出处，反查不到的丢弃（与 keyPoints 同一条不变量）。
 * 单独抽出来是因为 `parseQuotedSummary` 也要能读这个字段，而它不需要反查。
 */
function buildChanges(
  summary: StructuredSummary,
  draftSources: { name: string; url: string; text: string }[] | undefined,
): QuotedAmendmentChange[] {
  const raw = Array.isArray(summary.changes) ? summary.changes : [];
  const out: QuotedAmendmentChange[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const change = item as unknown as Record<string, unknown>;
    const quote = cleanQuote(typeof change.quote === 'string' ? change.quote : '');
    const pointText = typeof change.text === 'string' ? change.text.trim() : '';
    const clause = typeof change.clause === 'string' ? change.clause.trim() : '';
    if (quote === null || pointText === '') continue;
    const source = findDraftSourceForQuote(quote, draftSources);
    if (source === null) continue;
    const kind = typeof change.kind === 'string' ? change.kind : '';
    out.push({
      clause,
      kind: (['modify', 'add', 'delete', 'renumber', 'other'] as string[]).includes(kind)
        ? (kind as ChangeKind)
        : 'other',
      text: pointText,
      quote,
      source: source.name,
      sourceUrl: source.url,
    });
  }
  return out;
}

/** 落库的改动点数组 → 内存形状（缺字段/类型不对的条目丢掉，不让一行脏数据打断整页渲染） */
function parseStoredChanges(value: unknown): QuotedAmendmentChange[] {
  if (!Array.isArray(value)) return [];
  const out: QuotedAmendmentChange[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const change = item as Record<string, unknown>;
    const text = typeof change.text === 'string' ? change.text.trim() : '';
    const quote = typeof change.quote === 'string' ? change.quote.trim() : '';
    const clause = typeof change.clause === 'string' ? change.clause.trim() : '';
    if (text === '' || quote === '') continue;
    const kind = typeof change.kind === 'string' ? change.kind : 'other';
    const source = typeof change.source === 'string' && change.source !== '' ? change.source : null;
    const sourceUrl = typeof change.sourceUrl === 'string' && change.sourceUrl !== '' ? change.sourceUrl : null;
    out.push({
      clause,
      kind: (['modify', 'add', 'delete', 'renumber', 'other'] as string[]).includes(kind)
        ? (kind as ChangeKind)
        : 'other',
      text,
      quote,
      source,
      sourceUrl,
    });
  }
  return out;
}

/** 落库的改动表述计数（旧行为 null：页面那行覆盖度文字随之不出现） */
function parseStoredMarkers(value: unknown): ChangeMarkerCount | null {
  if (typeof value !== 'object' || value === null) return null;
  const markers = value as Record<string, unknown>;
  if (typeof markers.total !== 'number') return null;
  const byKind = markers.byKind as Record<string, unknown> | undefined;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    total: markers.total,
    byKind: {
      modify: num(byKind?.modify),
      add: num(byKind?.add),
      delete: num(byKind?.delete),
      renumber: num(byKind?.renumber),
    },
  };
}
/**
 * 安全校验 ai_summary_json（详情页渲染与检索索引前的防御性解析）：
 * 形状不符合 QuotedSummary 时返回 null，页面回退到占位文案，绝不让脏数据抛错打断渲染。
 *
 * 必填只有两段（what / howToComment）：**旧形状的行也要能解析**，否则摘要
 * 重刷的那一两个小时里，存量 58 条会从「有摘要」掉回「待人工复核」占位 —— 那比
 * 字段少更难看。所以 `keyPoints` 与新增的几段都按可选处理：有就带出来，没有就空。
 * 「影响谁」同样按可缺段处理（issue #56 第八节降级）。
 */
export function parseQuotedSummary(value: unknown): QuotedSummary | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  const section = (raw: unknown): SummarySection | null => {
    if (typeof raw !== 'object' || raw === null) return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.text !== 'string') return null;
    return {
      text: item.text,
      quote: typeof item.quote === 'string' && item.quote.length > 0 ? item.quote : null,
    };
  };
  /** 可缺段落：整段不存在时给空段（渲染层按 text 为空跳过），不算形状异常 */
  const optionalSection = (raw: unknown): SummarySection => section(raw) ?? { text: '', quote: null };

  // 截止日期段落的 text 允许为 null（原文未提及时）
  const deadlineSection = (raw: unknown): SummaryDeadlineSection | null => {
    if (typeof raw !== 'object' || raw === null) return null;
    const item = raw as Record<string, unknown>;
    if (item.text !== null && typeof item.text !== 'string') return null;
    return {
      text: typeof item.text === 'string' ? item.text : null,
      quote: typeof item.quote === 'string' && item.quote.length > 0 ? item.quote : null,
    };
  };

  const what = section(record.what);
  const deadline = deadlineSection(record.deadline);
  const howToComment = section(record.howToComment);
  if (!what || !deadline || !howToComment) return null;

  // 条文要点：`source` 缺失是**允许的** —— 改动前落库的旧格式摘要没有这个字段。
  // 缺就照实缺着，由渲染层标「未标出处」，而不是补一个看起来像出处的值。
  const keyPoints: QuotedDraftPoint[] = [];
  if (Array.isArray(record.keyPoints)) {
    for (const raw of record.keyPoints) {
      const point = section(raw);
      if (!point) return null;
      const item = raw as Record<string, unknown>;
      const sourceText = typeof item.source === 'string' ? item.source.trim() : '';
      const sourceUrl = typeof item.sourceUrl === 'string' ? item.sourceUrl.trim() : '';
      keyPoints.push({
        ...point,
        source: sourceText === '' ? null : sourceText,
        sourceUrl: sourceUrl === '' ? null : sourceUrl,
      });
    }
  }

  // 渠道项的形状是 {kind, value, quote}，没有 text —— 不能套上面的 section()；
  // 引用由 normalizeChannels 在去重之前按项配好。
  const channels = normalizeChannels(record.channels);

  return {
    what,
    who: optionalSection(record.who),
    whoCanSubmit: optionalSection(record.whoCanSubmit),
    afterDeadline: optionalSection(record.afterDeadline),
    keyPoints,
    // 改动点与覆盖度计数都是后加的字段：旧行没有 ⇒ 按"空 + 没数过"解析，
    // 不算形状异常（否则摘要重刷那段时间，存量条目会从"有摘要"掉回占位）。
    changes: parseStoredChanges(record.changes),
    changeMarkers: parseStoredMarkers(record.changeMarkers),
    deadline,
    howToComment,
    channels: channels.slice(0, MAX_CHANNELS),
  };
}

/**
 * 摘要模型名（notices.summary_model）：适配器可用 `model` 扩展属性上报
 * 具体模型（如 GLM_MODEL 的值），未上报时退回 provider 名（stub → 'stub'）。
 */
export function llmModelName(llm: LlmPort): string {
  const candidate = (llm as { model?: unknown }).model;
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate.trim();
  }
  return llm.provider;
}
