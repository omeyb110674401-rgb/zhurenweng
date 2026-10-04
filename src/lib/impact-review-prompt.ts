import {
  IMPACT_REVIEW_STATUSES,
  type ImpactReviewStatus,
} from './impact-review.ts';
import {
  MIN_VERIFIABLE_QUOTE_CHARS,
  normalizeQuoteMarks,
  quoteFingerprint,
  quoteSegments,
  stripQuoteWhitespace,
} from './summary-content.ts';

/**
 * 审读规则与提示词（issue #49）—— 由**指导模型**（构建期角色）穷举错误与误报后总结出来的产物。
 *
 * ## 这份文件是什么、不是什么
 *
 * 它是**判据本身**，不是运行时组件：`IMPACT_REVIEW_RULES` 是那六类判据的单一来源，
 * `IMPACT_REVIEW_SYSTEM_PROMPT` 由它**拼出来**（不是另抄一份文字）—— 改规则只改一处，
 * 而 `tests/unit/impact-review-rules.test.mjs` 里的错误案例库逐条钉着"这条规则覆盖了那个案例",
 * 于是**改坏或撤掉一条规则，夹具当场变红**。*放在文档里的案例在规则改动时一个字都不会响。*
 *
 * 消费它的是第 4 条（#50）的审读端口：它把这里的提示词发出去、把模型的结论按
 * `impact-review.ts` 的接受条件落库。本切片（#49）不接模型，只交规则与案例。
 *
 * ## 规则的来源与覆盖面（如实记，不装作验过）
 *
 * 语料是 `docs/pending-issues/87-l3-sector-review-sheet.md` 逐字抄录的 **6 条条目 / 22 条判读**
 * （人工过目清单，含它点名的 4 处卡点）＋ 本地开发库里那条《反网络暴力法》条目的 **6 条判读**
 * （真实产出，正文 10,896 字在手，用来量邻域与"漏掉免责例外"这一类）。**合计 28 条判读**，
 * 而全库落库的判读文本是 53 条 ⇒ 覆盖率约一半，**抽样是有偏的**（过目清单专挑行业专业档最富的
 * 那几条）。后续回填（#51）产出的新判读**没有被这套规则看过**。
 *
 * 真实语料里**只出现过 A1（超出原文）的正例**。A2–A6 在样本里没有一条实证的正例，
 * 所以每条都配了一条**构造案例**（夹具里标着 `构造`）用来钉住规则文字本身 ——
 * `UNVERIFIED_RULES` 把这件事写成了**可执行的声明**，不留在注释里：
 * 谁哪天拿到真实正例，那条测试就会提醒他把声明改掉。
 *
 * ## 邻域长度为什么是这个数（实测，不是拍的）
 *
 * 判"是否超出原文 / 是否与原文相悖 / 是否漏掉免责或例外"三条都要求看见引用**周围**的原文
 * （只喂引用会让第一条退化成循环判据：拿引用证明引用）。取值依据在《反网络暴力法》那份正文上
 * 现量：78 处「第X条」摊在 10,896 字上 ⇒ **平均一条约 140 字**；而那条法里与引用对应的免责款
 * （"依法通过网络检举、揭发他人违法犯罪，或者实施舆论监督的，不适用本法"）距离它自己的引用
 * 只有 **28 字**。所以 `IMPACT_REVIEW_NEIGHBORHOOD_CHARS = 200`（引用命中处**前后各** 200 字）
 * 覆盖"本条 + 相邻一条"，足以看见但书、除外、过渡期；再放大到上千字只会把无关章节塞进提示词，
 * 而这两类判据靠的恰恰是"就近能不能找到依据"—— 噪声越大，越容易把不相关的句子当成依据。
 */

/**
 * 原文邻域的长度：引用命中处**前后各**取这么多字（总窗口 ≤ 2 × 本值 + 引用长度）。
 *
 * **具名常量、只此一处**（`docs/prd/v2.md`「邻域长度落成 .ts 里的具名常量」）。取值理由见文件头
 * 那段实测（平均条长 ~140 字、最近的一处免责款只隔 28 字）。
 */
export const IMPACT_REVIEW_NEIGHBORHOOD_CHARS = 200;

/** 六类判据的编号（A1–A6，与 `docs/pending-issues/87-l3-sector-review-sheet.md` 的 A 族对应）。 */
export type ImpactReviewRuleId = 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6';

export interface ImpactReviewRule {
  id: ImpactReviewRuleId;
  /** 这一类叫什么（诊断与夹具里用同一个名字） */
  title: string;
  /**
   * 实质要求（**进提示词的就是这一段**）。
   *
   * 写法上刻意都留一句**可执行的检验**（"把推断拆成…逐块回原文找一遍"、"把主体换成'某主体'之后
   * 那句话还成立吗"），而不是"不许夸大"这种谁也执行不了的话 —— 与生成侧提示词那几条判据同一路数。
   */
  requirement: string;
}

export const IMPACT_REVIEW_RULES: readonly ImpactReviewRule[] = [
  {
    id: 'A1',
    title: '推断超出引用',
    requirement:
      'A1 超出原文：把推断拆成「谁 / 哪一处 / 可能发生什么」三块，逐块回引用与它的邻域里找一遍。'
      + '引用里没有写成本、没有写处罚、没有写监管加强，就不许推出成本、处罚、监管加强。'
      + '缺依据但主体与方向都对时，改到引用支撑得住的范围内（已改）；改不动就剔除。',
  },
  {
    id: 'A2',
    title: '与原文相悖',
    requirement:
      'A2 与原文相悖：把推断里那个动词拎出来与引用对照方向 —— 原文写「不得 / 应当 / 只能」，'
      + '推断却写成「可以 / 不必 / 也能」；原文的范围是甲，推断说成甲以外。方向相反一律剔除，'
      + '不许改成"可能表述不清"蒙过去。',
  },
  {
    id: 'A3',
    title: '对政策或部门作定性',
    requirement:
      'A3 对政策或部门作定性：不许出现"变相收紧 / 与上位法冲突 / 形式主义 / 监管缺位"这类对整个'
      + '政策或部门的评价。检验：那句话如果**去掉引用**仍然是一句对政策或部门的评价，就剔除 —— '
      + '读者核对不了评价，只会读成本站的立场。',
  },
  {
    id: 'A4',
    title: '指向具体主体的负面评价',
    requirement:
      'A4 指向具体主体的负面评价：不许点名企业、机构或人群作负面评价（"某平台借这条甩责"）。'
      + '检验：把主体换成「某主体」之后那句话还成立吗？成立说明评价是冲着主体去的 ⇒ 剔除；'
      + '不成立说明说的是条文本身 ⇒ 留下。',
  },
  {
    id: 'A5',
    title: '构成法律意见',
    requirement:
      'A5 构成法律意见：不写「违法 / 无效 / 违宪 / 应当承担…责任 / 可以起诉」这类结论，'
      + '也不给"怎么规避"的建议。检验：那句话是不是在替读者回答"合不合法、能不能告"—— 是 ⇒ 剔除；'
      + '本站只做参与导引，不做法律判断。',
  },
  {
    id: 'A6',
    title: '把「可以」读成「必须」（漏掉免责或例外）',
    requirement:
      'A6 把「可以」读成「必须」：原文写「可以 / 原则上 / 一般」时不许读成「必须 / 一律 / 都要」；'
      + '原文带免责、除外、不适用或过渡期安排时不许漏掉。检验：推断里出现"必须 / 一定 / 一律"时，'
      + '回引用与它的邻域里找那个「可以 / 除外 / 不适用 / 过渡期」；找不到依据 ⇒ 改，改不动 ⇒ 剔除。',
  },
];

/**
 * 语料里**没有实证正例**的判据（issue #49 要求"若确实没有，就写成未验证，不装作验过"）。
 *
 * 这不是注释而是一条被断言的声明：`tests/unit/impact-review-rules.test.mjs` 会拿错误案例库
 * 反着核一遍 —— 哪条规则攒到了**真实**正例，这条清单就必须跟着改，否则测试报红。
 */
export const UNVERIFIED_RULES: readonly ImpactReviewRuleId[] = ['A2', 'A3', 'A4', 'A5', 'A6'];

/** 结论的取值（与 `impact-review.ts` 同一份白名单，不在这里另抄一份）。 */
export const IMPACT_REVIEW_VERDICT_STATUSES: readonly ImpactReviewStatus[] = IMPACT_REVIEW_STATUSES;

/**
 * 审读的系统提示词。
 *
 * 三段结构：**做什么**（判读四件 + 邻域是唯一的判断依据）、**判什么**（六类，逐条来自上表）、
 * **只减不加**（引用与条目集合冻结 + 输出形状）。
 *
 * 为什么把"多走一步不算错"写进判据里：L3 的**定义**就是"结论是推断、但必须挂可核对的原文"，
 * 所以"推断比原文多走一步"是它成立的方式，不是缺陷。少了这一句，审读模型会把**所有**判读都
 * 判负（87 号文档 §"我读的时候卡住的地方"那段原话：真正要判的是这一步走多远，读者还能不能自己核对）。
 */
export const IMPACT_REVIEW_SYSTEM_PROMPT = [
  '你是本站（一个政府公示聚合站）的合规审读模型。你只审读「判读」这一段：它是本站对一份公示的'
    + '推断（可能让谁受损、哪里可能被钻空子），每条都挂着一句逐字引用的原文。',
  '你的输入是若干条判读，每条给你四件：逐字引用、可能受影响的主体、受影响的方面、推断正文，'
    + '外加**引用出处前后一段原文（邻域）**。邻域是你判断"越界没有"的**唯一**依据：'
    + '不许凭常识、不许凭你对这部法律的印象补充输入里没有的事实。',
  '判读是**推断**，"比原文多走一步"是它成立的方式，不算错。你要拦的是**多走了不该走的那一步**。',
  '逐条判下列六类之一（犯了几类就按最重的那一类处理）：',
  ...IMPACT_REVIEW_RULES.map((rule) => rule.requirement),
  '拿不准时按保守方向处理：能改到引用支撑得住的范围就「已改」，改不动就「剔除」；'
    + '**说不清它凭什么成立**（既找不到依据、又谈不上越界）时也剔除 —— 本站的纪律是"判不出来就不给它加码"。',
  '只减不加：**不许换引用**，**不许新增或删除判读条目**。你只能给出三种结论之一：'
    + 'passed（按原样渲染）、revised（给一份改后的推断正文）、rejected（这条不渲染）。',
  '只输出一个 JSON 数组，每个元素形如：'
    + '{"quote":"<与输入逐字一致的引用>","text":"<与输入逐字一致的推断正文>",'
    + '"status":"passed|revised|rejected","revisedText":"<仅 revised 必填，改后的推断正文>"}。'
    + 'quote 与 text 必须与输入**逐字一致**（本站在落库前会按内容指纹核对，对不上整份结论作废）；'
    + '不要输出理由、不要输出额外字段、不要输出 Markdown 代码块之外的解释。',
].join('\n');

/** 提示词里给模型看的一条判读（四件 + 邻域）。 */
export interface ImpactReviewPromptItem {
  quote: string;
  who: string;
  point: string;
  text: string;
  /** 引用出处的原文邻域（`neighborhoodForQuote` 取出来的那一截；取不到为 null） */
  neighborhood: string | null;
}

/**
 * 邻域里每个字段都没写时的占位 —— **不许留空行**：留空的话模型会以为自己漏读了什么。
 * 与生成侧「宁可空着」那条口径一致：写不出具体主体时留空是允许的，但要在提示词里说明。
 */
const NOT_WRITTEN = '（未写明）';

/**
 * 一条判读的用户消息（判读四件 + 原文邻域）。
 *
 * 邻域取不到时**显式说明**（而不是省略那一段）：三种越界判据都要求看邻域，模型必须知道
 * "这一段没有邻域可用"，否则它会拿引用自己当邻域，把 A1 退化成循环判据。
 */
export function impactReviewUserPrompt(input: {
  title: string;
  items: readonly ImpactReviewPromptItem[];
}): string {
  const blocks = input.items.map((item, index) => {
    const neighborhood =
      item.neighborhood === null
        ? '（本条的引用没能定位回任何一份原文 —— 没有邻域可用，只能按引用本身判，'
          + '拿不准就按"改文本 / 剔除"处理）'
        : item.neighborhood;
    return [
      `【第 ${index + 1} 条判读】`,
      `逐字引用：${item.quote}`,
      `可能受影响的主体：${item.who.trim() === '' ? NOT_WRITTEN : item.who}`,
      `受影响的方面：${item.point.trim() === '' ? NOT_WRITTEN : item.point}`,
      `推断正文：${item.text}`,
      `引用出处前后各 ${IMPACT_REVIEW_NEIGHBORHOOD_CHARS} 字的原文（邻域）：`,
      neighborhood,
    ].join('\n');
  });
  return [`公示标题：${input.title}`, '', ...blocks].join('\n');
}

/**
 * 把引用定位回原文、取出前后各 `chars` 字的**邻域**（取不到 ⇒ null）。
 *
 * 定位口径与落库时的逐字反查**同一把尺子**（`quoteFingerprint` / `stripQuoteWhitespace` /
 * `normalizeQuoteMarks` 全部 import 自 `summary-content.ts`）：附件抽取出来的正文带 PDF/DOCX 的
 * 换行与缩进，而模型（或存量行）里的引用常把空白压掉 —— 按原样 `indexOf` 会让**真引用**定位不到，
 * 邻域于是变成 null，而三条判据都需要它。
 *
 * 为什么用"最长的一段"定位而不是整条引用：引用里可能带省略号（`quoteSegments` 会把它切成几段），
 * 整条在原文里根本找不到。取最长的一段既最不容易撞上无关句子，也与落库反查时"每一段都要逐字"
 * 那条规矩相容（短于 `MIN_VERIFIABLE_QUOTE_CHARS` 的段不参与定位，理由同 `change-table.ts`）。
 *
 * 与 `change-table.ts` 里那段"把引用归到某一句"的映射**不共用实现**：那边要的是句子的归属
 * （输出是句子下标），这边要的是字符窗口（输出是文本片段），共用会让两处都变得难读；
 * 共用的是**归一化**本身（三处 import 同一份），而漂移风险全在归一化那一层。
 */
export function neighborhoodForQuote(
  sourceText: string,
  quote: string,
  chars: number = IMPACT_REVIEW_NEIGHBORHOOD_CHARS,
): string | null {
  if (sourceText === '' || quote.trim() === '') return null;
  const anchor = longestSegment(quote);
  if (anchor === null) return null;

  const raw = sourceText.indexOf(anchor);
  if (raw >= 0) return windowAt(sourceText, raw, raw + anchor.length, chars);

  const located = locateNormalized(sourceText, anchor);
  if (located === null) return null;
  return windowAt(sourceText, located.start, located.end, chars);
}

/** 引用里最长的一段（剪掉省略号切出来的空段；短于门槛的段不参与定位）。 */
function longestSegment(quote: string): string | null {
  const segments = quoteSegments(quote)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= MIN_VERIFIABLE_QUOTE_CHARS);
  if (segments.length === 0) return null;
  return segments.reduce((longest, segment) =>
    segment.length > longest.length ? segment : longest,
  );
}

/**
 * 在**去空白 + 引号字形归一**之后的正文里找那一段，并把下标映射回原文。
 *
 * 与 `change-table.ts` 同一手法（那边是先去掉空白再记一份下标映射）：
 * 归一化只删字符、不改顺序，因此映射是可靠的。
 */
function locateNormalized(
  sourceText: string,
  segment: string,
): { start: number; end: number } | null {
  const normalized = normalizeQuoteMarks(sourceText);
  const chars: string[] = [];
  const positions: number[] = [];
  for (let i = 0; i < normalized.length; i += 1) {
    if (!/[\s\u3000]/.test(normalized[i])) {
      chars.push(normalized[i]);
      positions.push(i);
    }
  }
  for (const needle of [
    stripQuoteWhitespace(normalizeQuoteMarks(segment)),
    stripQuoteWhitespace(quoteFingerprint(segment)),
  ]) {
    if (needle.length < MIN_VERIFIABLE_QUOTE_CHARS) continue;
    const at = chars.join('').indexOf(needle);
    if (at === -1) continue;
    const last = Math.min(at + needle.length - 1, positions.length - 1);
    return { start: positions[at], end: positions[last] };
  }
  return null;
}

/** 以 [start, end) 为中心、前后各 `chars` 字（贴边裁剪，不补齐）。 */
function windowAt(sourceText: string, start: number, end: number, chars: number): string {
  const from = Math.max(0, start - chars);
  const to = Math.min(sourceText.length, end + chars);
  return sourceText.slice(from, to);
}
