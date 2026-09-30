import {
  findChangeMarkers,
  type ChangeMarkerKind,
  type ChangeTable,
  type ChangeTableEntry,
} from './change-coverage.ts';
import {
  MIN_VERIFIABLE_QUOTE_CHARS,
  quoteFingerprint,
  quoteSegments,
  stripQuoteWhitespace,
} from './summary-content.ts';

/**
 * 「改了哪几处」那张表**行由程序定**的那一半（issue #86 第二十节第 3 小节）。
 *
 * 为什么需要它：原先这张表的内容**整体**来自模型 —— 模型写出几行就是几行。实测（§19.3）
 * 同一份输入跑四遍，列出的行数是 8 / 2 / 3 / 8，而页面上没有任何东西能让读者发现这一遍少了。
 * 这里把"哪些行"从模型手里拿走：按句（官方那串"一、二、三…"的条目）归并，
 * 每一句一行；模型写得出可核对说明的行照旧渲染，写不出的那一行只报事实。
 *
 * **判据必须与分母同源**：`text` 就是 `countChangeMarkers` 数过的**同一个字符串**
 * （worker 里是同一个局部变量），否则"检测到 N 处"与"表里有几行"会各说各话 ——
 * 那正是这一族问题里最难查的一种（页面上两个数都像真的）。
 *
 * 这一步是**纯函数**：不进 `summary-content.ts` 是因为它与"反查""落库形状"不是一件事，
 * 而它要用的引用指纹与分段规则**一律 import**，不在这里抄第二份 ——
 * 判据抄两份，漂移的表现是"表里的行与它引用的原文对不上"，而那种错看起来像模型写错了。
 */

/** 一句的范围（原文下标） */
export interface SentenceSpan {
  start: number;
  end: number;
}

/** 一句的边界：中文句读与换行。与 `scripts/probe-change-markers.mjs` 同一口径。 */
const SENTENCE_END = '。；！？\n';

/** 被改条款标识（含款）。**照抄原文写法**，抽不到就是空串（与模型那一路的 `clause` 同义）。 */
const CLAUSE_RE = /第[一二三四五六七八九十百零两0-9]{1,6}条(第[一二三四五六七八九十]{1,3}款)?/;

/** 子条目开头（「（一）」/「(1)」）—— 用来判上一句是不是"下面挂着一串子条目"的小标题。 */
const SUB_ITEM_START_RE = /^\s*[（(][一二三四五六七八九十0-9]{1,3}[）)]/;

/** 把正文按句切开（保留每句在原文里的下标）。空句也返回，由调用方按需过滤。 */
export function sentenceSpans(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (SENTENCE_END.includes(text[i])) {
      spans.push({ start, end: i + 1 });
      start = i + 1;
    }
  }
  if (start < text.length) spans.push({ start, end: text.length });
  return spans;
}

/** 从一句里抽出条号（抽不到给空串，页面据此印破折号）。 */
export function clauseOfSentence(sentence: string): string {
  return (CLAUSE_RE.exec(sentence) ?? [''])[0];
}

/**
 * 这一句是不是**小标题**（不单独成行）。
 *
 * 判据写出来，不靠"看着像标题"：句子里**没有引号引起来的条款内容**，
 * 且紧跟着的那一句以子条目开头 —— 也就是它下面挂着一串子条目。
 *
 * 两个"紧跟着"都算：正文里的下一句，以及下一句**带改动表述**的句子。
 * 实测那一例（「八、对部分条文作以下修改：」）两种读法都成立；留两个是因为
 * 中间夹一句普通句子时，前者会漏判，而漏判的后果是给一个标题印一行
 * "检测到改动表述却没说明" —— 那会把这个分母里本来就混着标题的毛病摆到读者面前。
 */
export function isHeaderSentence(sentence: string, nextCandidates: (string | undefined)[]): boolean {
  if (/[“”"]/.test(sentence)) return false;
  return nextCandidates.some((next) => next !== undefined && SUB_ITEM_START_RE.test(next));
}

/**
 * 造出这张表。`text` 必须是**数分母用的那一个字符串**（见文件头）。
 *
 * `changes` 只用到 `quote`：它要回答的是"这一行说的是哪一句"，不是"这一行写了什么"。
 */
export function buildChangeTable(text: string, changes: { quote: string }[]): ChangeTable {
  const source = text ?? '';
  const markers = findChangeMarkers(source);
  if (markers.length === 0) return { entries: [], headers: 0 };

  // 去空白后的全文 + 每个字回原文的下标：模型常把附件里的换行与缩进压成一行，
  // 按原样 indexOf 会把**真的逐字引用**判成"不属于任何一句"（指纹口径见 summary-content 的
  // `quoteFingerprint`，这里只是把它的"去空白"也用在 haystack 上）。
  const chars: string[] = [];
  const positions: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    if (!/[\s\u3000]/.test(source[i])) {
      chars.push(source[i]);
      positions.push(i);
    }
  }
  const haystack = chars.join('');

  /**
   * 这一段引用在我们读到的正文里的起止下标（找不到 = null）。
   *
   * 两种写法都试：原样的去空白版，以及**再去掉包裹引号**的指纹版（与落库时那一关同一口径，
   * 见 `quoteFingerprint`）。只试一种的话，`“……` 这种以引号开头的段会找不到 ——
   * 后果不是出错，而是那一行被挪到表尾（见下面的兜底），读者会觉得顺序莫名其妙。
   *
   * 只取**首次出现**，所以每段都必须够长：短于 `MIN_VERIFIABLE_QUOTE_CHARS` 的段本来就不该
   * 出现在落库的引用里（`findDraftSourceForQuote` 会把整行丢掉），这里跟着同一个门槛，
   * 于是"首次出现"不至于撞上一句无关的话。
   */
  const locate = (segment: string): { start: number; end: number } | null => {
    if (segment.length < MIN_VERIFIABLE_QUOTE_CHARS) return null;
    for (const needle of [stripQuoteWhitespace(segment), stripQuoteWhitespace(quoteFingerprint(segment))]) {
      if (needle.length < MIN_VERIFIABLE_QUOTE_CHARS) continue;
      const at = haystack.indexOf(needle);
      if (at === -1) continue;
      const last = Math.min(at + needle.length - 1, positions.length - 1);
      return { start: positions[at], end: positions[last] };
    }
    return null;
  };

  const spans = sentenceSpans(source);
  const sentences = spans.map((span) => source.slice(span.start, span.end).trim());
  const hitsOf = spans.map((span) =>
    markers.filter((marker) => marker.index >= span.start && marker.index < span.end),
  );
  /** 这一段引用**碰到了**哪几句（附件里的换行会把一句官方条目切成几段，所以要按整段算） */
  const touchedBy = (segment: string): number[] => {
    const range = locate(segment);
    if (range === null) return [];
    return spans
      .map((_, index) => index)
      .filter((index) => spans[index].end > range.start && spans[index].start <= range.end);
  };
  /**
   * 每一行改动说明说的是**哪一句**（-1 = 它引的原文不在我们数分母的那段文本里）。
   *
   * 取"它碰到的第一句**带改动表述**的句子**"，而不是"它起始的那一句"：附件抽取出来的正文
   * 在句子中间就有换行，于是 `一、将第五条中的\n“贫困地区”修改为\n“欠发达地区”。`
   * 会被切成三句，而引用是从第一段中间开始的 —— 按起始句归属，那一行会掉到不认识它的句子名下，
   * 最后被挪到表尾，而真正带"修改为"的那一段反而印成一行"没能给出说明"（实测于本文件的单测）。
   * 碰到哪几句是**逐字算出来的**（引用各段的位置），不是猜的。
   */
  const sentenceOfChange = changes.map((change) => {
    const touched: number[] = [];
    for (const segment of quoteSegments(change.quote)) {
      for (const index of touchedBy(segment)) {
        if (!touched.includes(index)) touched.push(index);
      }
    }
    touched.sort((a, b) => a - b);
    if (touched.length === 0) return -1;
    const withMarkers = touched.filter((index) => hitsOf[index].length > 0);
    return withMarkers.length > 0 ? withMarkers[0] : touched[0];
  });

  const entries: ChangeTableEntry[] = [];
  const used = new Set<number>();
  const withMarkers = spans
    .map((_, index) => index)
    .filter((index) => hitsOf[index].length > 0 && sentences[index] !== '');
  let headers = 0;

  withMarkers.forEach((spanIndex, position) => {
    const sentence = sentences[spanIndex];
    const nextInDocument = sentences.slice(spanIndex + 1).find((text) => text !== '');
    const nextWithMarkers = sentences[withMarkers[position + 1] ?? -1];
    if (isHeaderSentence(sentence, [nextInDocument, nextWithMarkers])) {
      headers += 1;
      return;
    }
    const kinds: ChangeMarkerKind[] = [];
    for (const kind of hitsOf[spanIndex]) {
      if (!kinds.includes(kind.kind)) kinds.push(kind.kind);
    }
    const hits = sentenceOfChange
      .map((owner, index) => ({ owner, index }))
      .filter((item) => item.owner === spanIndex && !used.has(item.index))
      .map((item) => item.index);
    if (hits.length === 0) {
      entries.push({
        type: 'fact',
        clause: clauseOfSentence(sentence),
        kinds,
        sentence,
      });
      return;
    }
    for (const index of hits) {
      entries.push({ type: 'described', change: index });
      used.add(index);
    }
  });

  // **一行都不许丢**：引用跨了句边界之外的情形（引的原文没落在任何一句里、或落在被当成标题的
  // 那一句里）都会走到这儿。它们按原顺序补在表尾 —— 顺序略偏，但"说明连同原文"必须还在页面上
  // 出现（少一行就是这张表要比掉的旧毛病）。
  changes.forEach((_, index) => {
    if (!used.has(index)) entries.push({ type: 'described', change: index });
  });

  return { entries, headers };
}

/**
 * 页面上要渲染哪几行（页面、验收脚本共用这一份判据）。
 *
 * 有表就按**表的行序**（程序定的：正文顺序、缺口在它该在的位置）；没有表 —— 那是这一版
 * 之前落库的老行 —— 退回旧样子：只列模型写出的那几行。两条路必须在这一处收口：
 * 页面与验收脚本各判一次，"读者看到的"与"验收门印的"就会分家，而分家正是那只量具
 * 前七次说谎的同一个成因。
 */
export function changeTableRows(
  changes: { quote: string }[],
  table: ChangeTable | null,
): ChangeTableEntry[] {
  if (table !== null && table.entries.length > 0) return table.entries;
  return changes.map((_, index) => ({ type: 'described' as const, change: index }));
}

/** 表里有几行有说明、几行只报事实（那一句交代要用它，页面与验收脚本同源）。 */
export function changeTableCounts(entries: ChangeTableEntry[]): {
  described: number;
  factOnly: number;
} {
  const described = entries.filter((entry) => entry.type === 'described').length;
  return { described, factOnly: entries.length - described };
}
