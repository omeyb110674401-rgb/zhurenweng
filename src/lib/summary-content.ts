
import type {
  ImpactKind,
  LlmPort,
  StructuredSummary,
  SummaryChannel,
  SummaryChannelKind,
} from './ports.ts';
import type { SummaryDiagnostics } from './summary-diagnostics.ts';
import {
  CHANGE_KIND_LABELS,
  CHANGE_MARKER_KINDS,
  type ChangeKind,
  type ChangeMarkerCount,
  type ChangeTable,
  type ChangeTableEntry,
} from './change-coverage.ts';

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
/**
 * 一条编制说明要点（issue #76 第 3 刀）。
 *
 * 与条文要点的关键区别：它的出处**只能是说明类附件**。条文里的话不能用来
 * "概括说明"，说明里的话也不能当作"规定本身"落进 keyPoints / changes ——
 * 段落隔离由 `buildQuotedSummary` 按 role 分别反查来保证，不依赖模型听话。
 */
export interface QuotedExplanationPoint {
  /** 该小节自己的标题，照抄原文 */
  heading: string;
  text: string;
  quote: string;
  source: string | null;
  sourceUrl: string | null;
}

/** 影响类型的展示名（页面按它分组；`other` 是兜底桶，只为"不给判读贴错标签"而存在）。 */
export const IMPACT_KIND_LABELS: Record<ImpactKind, string> = {
  risk: '可能的不利后果',
  loophole: '可能被规避或滥用',
  burden: '新增的义务或成本',
  other: '其他可能的影响',
};

/**
 * 一条影响判读（issue #86 第 1 刀）—— 本站**唯一一段允许推断**的内容。
 *
 * 它与别的段落形状一样（都带 `quote` 与程序反查出来的 `source`），但两者的**证据地位不同**：
 * - `quote` / `source` 是**可核对的**：逐字、由 `findDraftSourceForQuote` 反查出处，
 *   反查不到整条不落库（与 keyPoints 同一条不变量）；
 * - `text` / `who` / `kind` 是**推断**，不可核对。所以页面把两者排在同一行里，
 *   绝不让推断脱离原文单独成立，并且这一段有**块级**免责声明（不只是卡片头部那行）。
 *
 * 引用可以在**任何一份**喂进去的附件里反查（不做段落隔离，理由见 `buildImpacts`）。
 */
export interface QuotedImpactPoint {
  quote: string;
  /** 可能受影响的具体主体；模型写不出具体主体时为空串（页面据空不渲染那半句） */
  who: string;
  /** 可能带来什么：一句话的推断 */
  text: string;
  kind: ImpactKind;
  source: string | null;
  sourceUrl: string | null;
}

/**
 * 一处改动（issue #86 第 2 刀）—— 「改了哪几处」的那一行。
 *
 * 与「可能的争议点」的形状几乎一样，但**证据地位是反的**：这一整行都是**事实**，
 * `quote` 是逐字原文、`source` 由程序反查，`clause` / `kind` / `text` 是对那一句官方文字的
 * 分类与概括。页面把三者与原文排在同一行里给读者对照 —— 说明本身不可逐字核对，
 * 所以绝不让它脱离原文单独成立（这条规矩是 #76 立的，重建时一个字没改）。
 *
 * 引用可以在**任何一份**喂进去的附件里反查：实测（86 号文档第九节）显示法律修正草案的
 * 对照句在**正文**附件里（10 条引用全部命中条文侧），而住建部那批在**编制说明**里 ——
 * 旧实现只认条文侧，那正是它白丢一半的原因之一。
 */
export interface QuotedAmendmentChange {
  /** 被改条款标识（照抄原文写法；原文没写条号时为空串） */
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
  /**
   * 谁能提。
   *
   * **页面自 2026-10-02（两栏版式这一刀）起整段不渲染**（用户拍板：96 条摘要里 95 条的取值
   * 等价于"公众可提"、平均 10.4 字、28% 是空的 —— 它复述的是读者点进来之前就知道的事实）。
   * 落库形状一个字没动：存量摘要在重刷完成前仍带着它，`scripts/audit-attachment-extraction.mjs`
   * 也还在用它量"who 抄了 whoCanSubmit"这件事。删的是那一段渲染，不是这个字段。
   */
  whoCanSubmit: SummarySection;
  /** 逾期会怎样（同上） */
  afterDeadline: SummarySection;
  /** 历史字段（#56 停用）→ 现为**草案条文要点**：只有喂了附件条文才会产生（issue #57 第 5 步） */
  keyPoints: QuotedDraftPoint[];
  /** 编制说明要点（issue #76 第 3 刀）：引用只能来自说明类附件 */
  explanationPoints: QuotedExplanationPoint[];
  /** 可能的影响（issue #86 第 1 刀）：唯一允许推断的一段，每条都挂着可核对的原文 */
  impacts: QuotedImpactPoint[];
  /** 「改了哪几处」（issue #86 第 2 刀）：全行都是事实，逐字可核对 */
  changes: QuotedAmendmentChange[];
  /** 全部附件正文里数到的改动表述数（覆盖度那句"共 N 处"的分母）；null = 没数过 */
  changeMarkers: ChangeMarkerCount | null;
  /**
   * 「改了哪几处」那张表的**行序与缺口**（issue #86 第二十节第 3 小节）；null = 没造过。
   *
   * 与 `changes` 的关系是"骨架与肉"：`changes` 是模型写出、且过了逐字反查的说明行，
   * 这张表决定**页面上按什么顺序出现哪些行**（含只有事实、没有说明的那几行）。
   * 它是落库**之后**由 worker 补上的（要等 `changes` 定下来才知道每行说的是哪一句），
   * 所以 `buildQuotedSummary` 给的是 null —— 页面见 null 就退回"只列模型写出的行"。
   */
  changeTable: ChangeTable | null;
  /** 说明全文里检测到的小节数（覆盖度那行的分母，带"约"）；null = 没喂说明 */
  explanationSections: number | null;
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
  /**
   * 这次调用的诊断（issue #86 第 0 刀）：模型吐了什么、丢了什么、丢在哪一关。
   * 与 `quotes` 同一种扩展手法 —— 端口形状（ports.ts）是并行切片共享的接缝，不动它。
   */
  diagnostics?: SummaryDiagnostics;
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
 * 把同一族的引号字形归一到同一种表示（**只动引号字符**，别的字符一个都不动）。
 *
 * 为什么需要它（2026-09-30 生产实测）：逐字反查要求模型的 `quote` 在本轮真喂进去的正文里
 * 逐字出现，而附件原文里是中文引号 `“ ”`、模型这一遍吐的是 ASCII 直引号 `"` —— 词句
 * 逐字一致，只差字形，整行就被判"对不上"。那一次 **9 行全部**这样丢掉（改动点 0/9，
 * 页面上「改了哪几处」只剩事实行）；换一遍模型用中文引号，同一份输入就保住 5–8 行。
 * 所以这不是偶发，是一个**按引号字形整批丢**的开关。
 *
 * 归一方向：双引号族（`"` `“` `”` `＂` `〝` `〞` `「` `」` `『` `』`）算同一个字，
 * 单引号族（`'` `‘` `’` `＇`）同理；两族之间**不互相等价**（`'甲'` 对不上 `"甲"` ——
 * 单双引号在公文里本来就分得开，混着归一反而会造出假的命中）。
 *
 * **一对一是硬要求**：`change-table.ts` 的按句归并要把归一后的下标回推成原文下标，
 * 长度一变那个映射就错了。也正因为只换字形，其余判据一个字都没松 —— 改了一个实词、
 * 少了一段、顺序颠倒、某一段短于门槛，照样丢（反向用例钉在
 * `tests/unit/summary-draft-points.test.mjs`）。
 */
export function normalizeQuoteMarks(text: string): string {
  return text
    .replace(/[“”＂〝〞「」『』]/g, '"')
    .replace(/[‘’＇]/g, "'");
}

/**
 * 去掉全部空白（含全角空格）。
 *
 * 抽出来是因为**两处判据共用它**：引用指纹（下面那个）与「改了哪几处」的按句归并
 * （`change-table.ts` 要在去空白后的正文里定位引用）。各写一份正则，漂移的表现是
 * "表里的行与它引用的原文对不上" —— 看起来像模型写错了，其实是我们的两把尺子不一样。
 *
 * 同一族里还有一层「引号字形」的归一（`normalizeQuoteMarks`）：它同样由上面两处共用、
 * 同样只能 import 不能各写一份 —— 理由一模一样，只差这一次漂移的是引号而不是空白。
 */
export function stripQuoteWhitespace(text: string): string {
  return text.replace(/[\s\u3000]+/g, '');
}

/**
 * 引用与条文比对用的「指纹」：引号字形归一 + 去掉全部空白与包裹引号。
 *
 * 为什么要去空白：附件抽取出来的文本带 PDF/DOCX 的换行与缩进，模型引用时常把它们压成
 * 一行 —— 按原样 indexOf 会把**真的逐字引用**判成对不上，那种误杀等于让附件白读一遍。
 * 去掉空白只可能让比对**变松**（不会凭空造出匹配），代价是可接受的方向。
 *
 * 为什么还要归一引号字形（2026-09-30 补）：同一句话唯一的差别常常只是 `“ ”` 与 `"`，
 * 而那是**排版**不是**内容**（见 `normalizeQuoteMarks`）；把它算成改写，代价是整行说明
 * 从页面上消失。放在这一步是**两边同时生效**的：反查里引用分段与来源正文都走
 * `quoteFingerprint`（`findDraftSourceForQuote`），不存在只归一了一边的可能。
 *
 * 导出给 `change-table.ts` 用（第二十节第 3 小节）：它要在同一份正文里按引用各段的起点
 * 把一行归到某一句上，用的必须是**落库那一关的同一把尺子** —— 各写一份的表现是
 * "表里的行与它引用的原文对不上"，看起来像模型写错了。
 *
 * 包裹引号那一段正则仍留着中文引号字形：归一之后它只会遇到 `"` / `'`，留着宽一点的集合
 * 不改变行为，只是让这一步在归一被摘掉时照旧工作。
 */
export function quoteFingerprint(text: string): string {
  return stripQuoteWhitespace(normalizeQuoteMarks(text)).replace(/^["'“「『]|["'”」』]$/g, '');
}

/**
 * 短于这个字数的"引用"不构成可核对的出处。
 * 像「第三条」「本办法」这种片段在任何公文里都能蒙中，标它「摘自附件《X》」等于给一句
 * 没有信息量的话盖上"有据可查"的章 —— 宁可丢条目，不标假出处。
 *
 * 导出来给 `change-table.ts` 用：它靠引用各段的起点把一行归到某一句上，而"起点"只有当
 * 这一段够长时才是可靠的（短段在长文里到处都是）。两处共用一个门槛，才不会出现
 * "落库时够长、归句时又不算"这种自相矛盾。
 */
export const MIN_VERIFIABLE_QUOTE_CHARS = 8;

/**
 * 引用里的省略号（issue #86 第 1 刀）。
 *
 * **为什么必须容忍它**：2026-09-27 的实验（`scripts/probe-amendment-changes.mjs`，
 * 用旧提示词重跑《公路法（修正草案）》）量到 —— 模型一次吐 10 条改动点，**2 条因为
 * 引用中间带省略号被丢掉**，也就是白白损失 20% 的产出。而省略号是**我们自己教它的**：
 * 提示词的字段示例里就写着「第三条修改为：……」。
 *
 * **容忍的边界**：只容忍"引用中间有省略"，不容忍"引用对不上"。做法是按省略号切成若干段，
 * **每一段都必须在原文里逐字出现、且按先后顺序**（见 `containsInOrder`）——
 * 而**展示时那个缺口照原样留着**（落库的是模型给的原文，不是拼回来的），
 * 否则页面上那句「本站从附件逐字提取，未做改写」就变成了假话。
 */
const QUOTE_ELLIPSIS_RE = /…+|\.{2,}/;

/** 把一条引用按省略号切成若干段（去空、去空白）。没有省略号时就是它自己一段。 */
export function quoteSegments(quote: string): string[] {
  return quote
    .split(QUOTE_ELLIPSIS_RE)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** 若干段是否在 haystack 里**按顺序**逐字出现（各段不重叠）。 */
function containsInOrder(haystack: string, needles: string[]): boolean {
  let from = 0;
  for (const needle of needles) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    from = at + needle.length;
  }
  return true;
}

/**
 * 在给出的条文里反查这条引用的出处；找不到（或不可核对）返回 null。
 *
 * 判据（issue #86 第 1 刀起）：把引用按省略号切段，**每一段都要够长（≥8 字）**、
 * 且各段按顺序在原文里逐字出现。三段都够长的要求是有意的 —— 只判"总长"的话，
 * 「第一条…第二条…第三条」这种全是短碎片的引用就能蒙中任何公文。
 */
export function findDraftSourceForQuote<T extends { name: string; url: string; text: string }>(
  quote: string | null,
  sources: T[] | undefined,
): T | null {
  if (!quote) return null;
  const segments = quoteSegments(quote).map(quoteFingerprint);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment.length < MIN_VERIFIABLE_QUOTE_CHARS)) return null;
  for (const source of sources ?? []) {
    if (containsInOrder(quoteFingerprint(source.text), segments)) return source;
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
/**
 * 反查阶段"丢在哪一关"的计数（issue #86 第 0 刀）。
 *
 * 只记一类，因为这一关只做一件事：把引用拿到本轮**真的喂进去**的文本里去找。
 * 找不到就丢（那是 `findDraftSourceForQuote` 返回 null 的唯一含义），所以只有一种原因，
 * 不需要编第二个类别 —— 而"丢在哪一关"这个信息本身，正是 #79 当初缺的那个。
 */
export interface VerifyTally {
  /** 引用在本轮喂进去的条文 / 说明里反查不到出处，整条被丢弃 */
  quoteNotFound: number;
}

export function buildQuotedSummary(
  summary: StructuredSummary,
  quotes?: SummaryQuotes,
  draftSources?: { name: string; url: string; text: string; role?: 'draft' | 'explanation' | 'other' }[],
  explanationSections?: number | null,
  changeMarkers?: ChangeMarkerCount | null,
): QuotedSummary {
  return buildQuotedSummaryWithTally(
    summary,
    quotes,
    draftSources,
    explanationSections,
    changeMarkers,
  ).summary;
}

/**
 * 与 `buildQuotedSummary` 同一份实现，额外把"反查掉了多少条"交出来（issue #86 第 0 刀）。
 *
 * 为什么是"同一份实现 + 多一个出口"而不是另写一个计数函数：另写一遍就是让条数上限与
 * 反查判据存在第二份实现，而两份实现漂移的表现是**诊断说没丢、实际丢了** ——
 * 那恰好是这个功能要消灭的那类静默（#79 的整个教训）。
 */
export function buildQuotedSummaryWithTally(
  summary: StructuredSummary,
  quotes?: SummaryQuotes,
  draftSources?: { name: string; url: string; text: string; role?: 'draft' | 'explanation' | 'other' }[],
  explanationSections?: number | null,
  changeMarkers?: ChangeMarkerCount | null,
): { summary: QuotedSummary; tally: VerifyTally } {
  // 段落隔离（issue #76 第 3 刀）：条文侧的引用只在条文里反查，说明侧只在说明里。
  // 不这么做，"摘自官方原文"这句话就会被一句其实来自编制说明的话撑起 ——
  // 那是对规定的解释，不是规定本身，读者按"条文"去读会读错。
  const draftSide = (draftSources ?? []).filter((source) => source.role !== 'explanation');
  const explanationSide = (draftSources ?? []).filter((source) => source.role === 'explanation');
  const rawPoints = Array.isArray(summary.keyPoints) ? summary.keyPoints : [];
  const quotePoints = Array.isArray(quotes?.keyPoints) ? (quotes.keyPoints as (string | null)[]) : [];
  const text = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : '';
  const tally: VerifyTally = { quoteNotFound: 0 };

  const keyPoints: QuotedDraftPoint[] = [];
  rawPoints.forEach((point, index) => {
    const pointText = text(point);
    if (pointText === '') return;
    const quote = cleanQuote(quotePoints[index]);
    const source = findDraftSourceForQuote(quote, draftSide);
    // 反查不到 ⇒ 这条要点没有可核对的出处（模型改写了原文，或从公告壳里"提炼"出条文）。
    // 丢弃而不是照登：详情页那句「摘自官方原文」不该为一条核对不上的话背书。
    if (source === null) {
      // 空文本条目在上一步就返回了，没走到这里 —— 所以这一计数只统计"反查失败"，
      // 不会把"模型给了个空要点"混进来（那是归一化阶段的 emptyOrInvalid）
      tally.quoteNotFound += 1;
      return;
    }
    keyPoints.push({ text: pointText, quote, source: source.name, sourceUrl: source.url });
  });

  const explanationPoints = buildExplanationPoints(summary, explanationSide, tally);
  const impacts = buildImpacts(summary, draftSources ?? [], tally);
  const changes = buildChanges(summary, draftSources ?? [], tally);

  return {
    summary: {
      what: { text: text(summary.what), quote: cleanQuote(quotes?.what) },
      who: { text: text(summary.who), quote: cleanQuote(quotes?.who) },
      whoCanSubmit: { text: text(summary.whoCanSubmit), quote: cleanQuote(quotes?.whoCanSubmit) },
      afterDeadline: { text: text(summary.afterDeadline), quote: cleanQuote(quotes?.afterDeadline) },
      keyPoints,
      explanationPoints,
      impacts,
      changes,
      changeMarkers: changeMarkers ?? null,
      // 表由 worker 在 `changes` 定下来之后补（见 QuotedSummary.changeTable 的注释）：
      // 它是"行序 + 缺口"，而缺口要在反查之后才知道 —— 在这里算不了。
      changeTable: null,
      explanationSections: explanationSections ?? null,
      deadline: {
        text:
          summary.deadline === null || summary.deadline === undefined
            ? null
            : text(summary.deadline) || null,
        quote: cleanQuote(quotes?.deadline),
      },
      howToComment: { text: text(summary.howToComment), quote: cleanQuote(quotes?.howToComment) },
      channels: normalizeChannels(summary.channels, quotes?.channels),
    },
    tally,
  };
}

/**
 * 说明要点：引用必须落在说明类附件里；小节标题没抄对也保留（不影响可核对性）。
 *
 * `tally` 只统计**反查失败**（`quoteNotFound`）。上面那两处 `continue`（缺引用 / 缺正文）
 * 刻意不记在这里：它们属于归一化阶段的 `emptyOrInvalid`，而这个函数在人工录入那条路上
 * 也会被调用 —— 把两种原因混进同一个计数器，就会让"模型改写了原文"和"模型给了个空条目"
 * 变得无法区分，而这两件事的处置完全不同。
 */
function buildExplanationPoints(
  summary: StructuredSummary,
  explanationSources: { name: string; url: string; text: string; role?: 'draft' | 'explanation' | 'other' }[],
  tally: VerifyTally,
): QuotedExplanationPoint[] {
  const raw = Array.isArray(summary.explanationPoints) ? summary.explanationPoints : [];
  const out: QuotedExplanationPoint[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const point = item as unknown as Record<string, unknown>;
    const quote = cleanQuote(typeof point.quote === 'string' ? point.quote : '');
    const text = typeof point.text === 'string' ? point.text.trim() : '';
    const heading = typeof point.heading === 'string' ? point.heading.trim() : '';
    if (quote === null || text === '') continue;
    const source = findDraftSourceForQuote(quote, explanationSources);
    if (source === null) {
      tally.quoteNotFound += 1;
      continue;
    }
    out.push({ heading, text, quote, source: source.name, sourceUrl: source.url });
  }
  return out;
}

/**
 * 影响判读：引用可以在**任何一份**喂进去的附件里反查（issue #86 第 1 刀）。
 *
 * 与 `buildExplanationPoints` 的**段落隔离**不同，这里刻意不隔离。那两栏的标题
 * （「草案条文要点」「编制说明要点」）对读者承诺了"这是哪一种文字"，串了必须丢；
 * 而「可能的争议点」承诺的是"**这一条原文** + 本站据此的推断"—— 原文出自哪一份附件
 * 不影响可核对性，页面本来就把出处写成「出处：附件《X》」。
 * 这条不是想当然：2026-09-27 的实测（86 号文档第九节）显示，**法律修正草案的对照句
 * 在正文附件里**（10 条引用全部命中条文侧），而住建部那批的对照句在编制说明里 ——
 * 两边都是官方原文，只认一侧就会白丢一半。
 */
function buildImpacts(
  summary: StructuredSummary,
  sources: { name: string; url: string; text: string; role?: 'draft' | 'explanation' | 'other' }[],
  tally: VerifyTally,
): QuotedImpactPoint[] {
  const raw = Array.isArray(summary.impacts) ? summary.impacts : [];
  const out: QuotedImpactPoint[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const impact = item as unknown as Record<string, unknown>;
    const quote = cleanQuote(typeof impact.quote === 'string' ? impact.quote : '');
    const text = typeof impact.text === 'string' ? impact.text.trim() : '';
    // 与说明要点一样：缺引用或缺正文的在这里跳过（那属于归一化阶段的 emptyOrInvalid），
    // 只有"反查失败"才计入 tally —— 两种原因的处置完全不同
    if (quote === null || text === '') continue;
    const source = findDraftSourceForQuote(quote, sources);
    if (source === null) {
      tally.quoteNotFound += 1;
      continue;
    }
    const declared = typeof impact.kind === 'string' ? impact.kind : '';
    out.push({
      quote,
      text,
      who: typeof impact.who === 'string' ? impact.who.trim() : '',
      kind: (['risk', 'loophole', 'burden', 'other'] as string[]).includes(declared)
        ? (declared as ImpactKind)
        : 'other',
      source: source.name,
      sourceUrl: source.url,
    });
  }
  return out;
}

/**
 * 改动点：逐条反查出处，反查不到的整行丢弃（与 keyPoints 同一条不变量）。
 *
 * **与 `buildImpacts` 不同的是这里连 role 都不看** —— 全部喂进去的附件一起当池子。
 * 理由与影响判读相同（见 buildImpacts 的注释），但这里更硬：实测显示**法律修正草案的
 * 对照句就在正文附件里**，而"将A修改为B"这种写法在编制说明里同样常见，只认一侧必然白丢。
 */
function buildChanges(
  summary: StructuredSummary,
  sources: { name: string; url: string; text: string; role?: 'draft' | 'explanation' | 'other' }[],
  tally: VerifyTally,
): QuotedAmendmentChange[] {
  const raw = Array.isArray(summary.changes) ? summary.changes : [];
  const out: QuotedAmendmentChange[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const change = item as unknown as Record<string, unknown>;
    const quote = cleanQuote(typeof change.quote === 'string' ? change.quote : '');
    const text = typeof change.text === 'string' ? change.text.trim() : '';
    if (quote === null || text === '') continue;
    const source = findDraftSourceForQuote(quote, sources);
    if (source === null) {
      tally.quoteNotFound += 1;
      continue;
    }
    const declared = typeof change.kind === 'string' ? change.kind : '';
    out.push({
      quote,
      text,
      clause: typeof change.clause === 'string' ? change.clause.trim() : '',
      kind: (Object.keys(CHANGE_KIND_LABELS) as string[]).includes(declared)
        ? (declared as ChangeKind)
        : 'other',
      source: source.name,
      sourceUrl: source.url,
    });
  }
  return out;
}

/** 落库的说明要点数组 → 内存形状（旧行没这个字段 ⇒ 空数组，不算形状异常） */
function parseStoredExplanationPoints(value: unknown): QuotedExplanationPoint[] {
  if (!Array.isArray(value)) return [];
  const out: QuotedExplanationPoint[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const point = item as Record<string, unknown>;
    const text = typeof point.text === 'string' ? point.text.trim() : '';
    const quote = typeof point.quote === 'string' ? point.quote.trim() : '';
    const heading = typeof point.heading === 'string' ? point.heading.trim() : '';
    if (text === '' || quote === '') continue;
    const source = typeof point.source === 'string' && point.source !== '' ? point.source : null;
    const sourceUrl = typeof point.sourceUrl === 'string' && point.sourceUrl !== '' ? point.sourceUrl : null;
    out.push({ heading, text, quote, source, sourceUrl });
  }
  return out;
}

/**
 * 落库的影响判读数组 → 内存形状（issue #86 第 1 刀）。
 *
 * 与说明要点同样的宽容口径：**旧行没有这个字段 ⇒ 空数组，不算形状异常**。
 * 这一条不是形式主义：`impacts` 是本轮新增的键，而存量 84 条摘要全都没有它；
 * 解析若把它当必填，存量条目会从「有摘要」掉回「待人工复核」占位（#85 第三节的教训）。
 */
function parseStoredImpacts(value: unknown): QuotedImpactPoint[] {
  if (!Array.isArray(value)) return [];
  const out: QuotedImpactPoint[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const impact = item as Record<string, unknown>;
    const quote = typeof impact.quote === 'string' ? impact.quote.trim() : '';
    const text = typeof impact.text === 'string' ? impact.text.trim() : '';
    if (quote === '' || text === '') continue;
    const declared = typeof impact.kind === 'string' ? impact.kind : '';
    const source = typeof impact.source === 'string' && impact.source !== '' ? impact.source : null;
    const sourceUrl =
      typeof impact.sourceUrl === 'string' && impact.sourceUrl !== '' ? impact.sourceUrl : null;
    out.push({
      quote,
      text,
      who: typeof impact.who === 'string' ? impact.who.trim() : '',
      kind: (['risk', 'loophole', 'burden', 'other'] as string[]).includes(declared)
        ? (declared as ImpactKind)
        : 'other',
      source,
      sourceUrl,
    });
  }
  return out;
}

/**
 * 落库的改动点数组 → 内存形状（issue #86 第 2 刀）。
 *
 * 与说明要点、影响判读同样宽容：**缺字段的条目不落库、旧行没有这个键也不算形状异常**。
 * 这一条特别要紧：`changes` 与 `changeMarkers` 是**删过又装回来的键** ——
 * 生产库里有 5 行摘要带着 #85 之前的旧键（`changes` 为空数组、`changeMarkers` 为 null），
 * 而 #85 的读侧兼容测试正是用它们钉的。解析必须照常吃下这两种形状。
 */
function parseStoredChanges(value: unknown): QuotedAmendmentChange[] {
  if (!Array.isArray(value)) return [];
  const out: QuotedAmendmentChange[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const change = item as Record<string, unknown>;
    const quote = typeof change.quote === 'string' ? change.quote.trim() : '';
    const text = typeof change.text === 'string' ? change.text.trim() : '';
    if (quote === '' || text === '') continue;
    const declared = typeof change.kind === 'string' ? change.kind : '';
    const source = typeof change.source === 'string' && change.source !== '' ? change.source : null;
    const sourceUrl =
      typeof change.sourceUrl === 'string' && change.sourceUrl !== '' ? change.sourceUrl : null;
    out.push({
      quote,
      text,
      clause: typeof change.clause === 'string' ? change.clause.trim() : '',
      kind: (Object.keys(CHANGE_KIND_LABELS) as string[]).includes(declared)
        ? (declared as ChangeKind)
        : 'other',
      source,
      sourceUrl,
    });
  }
  return out;
}

/** 落库的改动表述计数（旧行为 null：页面那行覆盖度文字随之不出现）。 */
function parseStoredMarkers(value: unknown): ChangeMarkerCount | null {
  if (typeof value !== 'object' || value === null) return null;
  const markers = value as Record<string, unknown>;
  if (typeof markers.total !== 'number') return null;
  const byKind = markers.byKind as Record<string, unknown> | undefined;
  const num = (raw: unknown): number => (typeof raw === 'number' ? raw : 0);
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
 * 落库的「改了哪几处」表 → 内存形状（issue #86 第二十节第 3 小节）。
 *
 * 宽容度与其它几段一致：**这个键是后加的，旧行没有它不是形状异常**（返回 null，
 * 页面退回"只列模型写出的行"），单行形状不对就跳过那一行 —— 一行脏数据不该把整张表
 * 变成占位块，更不该让存量条目白屏（#85 第三节的教训）。
 *
 * `described` 只存下标，所以这里**不检查下标是否越界**：越界与否要等拿到 `changes` 才知道，
 * 那是渲染层一行 `undefined` 判断的事 —— 在这个纯解析函数里检查，就得把 `changes` 传进来，
 * 于是"解析形状"和"核对内容"混成一件事。
 */
function parseStoredChangeTable(value: unknown): ChangeTable | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.entries)) return null;
  const entries: ChangeTableEntry[] = [];
  for (const item of raw.entries) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === 'described') {
      if (typeof entry.change !== 'number' || !Number.isInteger(entry.change) || entry.change < 0) {
        continue;
      }
      entries.push({ type: 'described', change: entry.change });
      continue;
    }
    if (entry.type !== 'fact') continue;
    const sentence = typeof entry.sentence === 'string' ? entry.sentence.trim() : '';
    if (sentence === '') continue;
    const declared = Array.isArray(entry.kinds) ? entry.kinds : [];
    const kinds = CHANGE_MARKER_KINDS.filter((kind) => declared.includes(kind));
    /**
     * 字面（2026-09-30 加的字段）：**旧行没有它**，而页面要照字眼说那句话
     * （「本站在这一句里数到了「删除」」）。缺就给空数组 —— 渲染层退回按 `kinds`
     * 的展示名说（「删除」这类字眼），于是**存量行不必重跑**也能拿到诚实措辞。
     */
    const marks = Array.isArray(entry.marks)
      ? entry.marks
          .filter((mark): mark is string => typeof mark === 'string' && mark.trim() !== '')
          .map((mark) => mark.trim())
      : [];
    entries.push({
      type: 'fact',
      clause: typeof entry.clause === 'string' ? entry.clause.trim() : '',
      kinds: [...kinds],
      marks,
      sentence,
    });
  }
  if (entries.length === 0) return null;
  return {
    entries,
    headers: typeof raw.headers === 'number' && raw.headers > 0 ? raw.headers : 0,
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
    // 说明要点与它的小节数都是后加的字段：旧行没有 ⇒ 按"空 + 没数过"解析，
    // 不算形状异常（否则摘要重刷那段时间，存量条目会从"有摘要"掉回占位）。
    explanationPoints: parseStoredExplanationPoints(record.explanationPoints),
    // 影响判读是本轮新增的键：旧行没有 ⇒ 空数组（理由见 parseStoredImpacts）
    impacts: parseStoredImpacts(record.impacts),
    // 改动点与它的分母是"删过又装回来"的键：三种历史形状（有值 / 空数组 / 根本没有）都要吃下
    changes: parseStoredChanges(record.changes),
    changeMarkers: parseStoredMarkers(record.changeMarkers),
    // 表是最后加上的键：旧行没有 ⇒ null（页面退回"只列模型写出的行"）
    changeTable: parseStoredChangeTable(record.changeTable),
    explanationSections: typeof record.explanationSections === 'number' ? record.explanationSections : null,
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
