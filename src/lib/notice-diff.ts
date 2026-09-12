/**
 * 条款对比引擎（issue #10）：把两轮公示的正文纯文本按条款（章 / 条 / 段落）
 * 切分，生成「相同 / 新增 / 删除 / 修改」四态差异行；修改行再做字符级片段
 * 标注（<del> / <ins> 语义由视图层渲染）。零依赖纯函数，/notices/[id]/diff
 * 对比视图直接消费。
 *
 * 算法（自实现，正文为中文纯文本、不可依赖分词器）：
 * 1. 切分：条 / 章编号行（第X条 / 第X章）开启新条款单元，其余行归属当前条
 *    （款 / 项层级）或自成段落；
 * 2. 锚定：以条款全文（去空白）完全相等为单位做最长公共子序列（LCS），
 *    LCS 匹配对即两版共同锚点（LCS 的极大性保证锚点间不存在完全相同单元）；
 * 3. 锚点间隙：同编号条款优先配对为「修改」（同一条被改写是轮次对比最常见
 *    情形）；其余按字符二元组 Dice 相似度贪心配对（≥ 阈值 → 修改），
 *    剩余旧单元 → 删除、新单元 → 新增；
 * 4. 修改行内做字符级 LCS，输出逐段 same / del / ins 片段（长度超限时退化为
 *    整段删除 + 整段新增）。
 */

/** 条款单元：切分后的最小对比粒度（正文按条 / 款 / 段落切分） */
export interface ClauseUnit {
  /** chapter 章 / article 条 / paragraph 段落 */
  kind: 'chapter' | 'article' | 'paragraph';
  /** 条款编号标签（如「第一条」「第二章」），段落为 null */
  label: string | null;
  /** 条款全文（含编号标签；归属同一条款的多行以 \n 连接） */
  text: string;
}

/** 差异行状态 */
export type DiffRowKind = 'same' | 'added' | 'removed' | 'modified';

/** 字符级片段（修改行的行内高亮） */
export interface DiffSegment {
  type: 'same' | 'del' | 'ins';
  text: string;
}

/** 一条差异行：kind 决定哪些侧有值 */
export interface DiffRow {
  kind: DiffRowKind;
  /** 旧版条款（same / removed / modified 时非空） */
  old: ClauseUnit | null;
  /** 新版条款（same / added / modified 时非空） */
  new: ClauseUnit | null;
  /** 修改行的字符级片段（old 侧含 del）；其余状态为 null */
  oldSegments: DiffSegment[] | null;
  /** 修改行的字符级片段（new 侧含 ins）；其余状态为 null */
  newSegments: DiffSegment[] | null;
}

/** 条 / 章编号行（含汉字与阿拉伯数字序号，如 第一条 / 第十二条 / 第2条） */
const ARTICLE_LABEL = /^第[一二三四五六七八九十百千零〇0-9]+条/;
const CHAPTER_LABEL = /^第[一二三四五六七八九十百千零〇0-9]+章/;

/** 修改配对的相似度阈值（字符二元组 Dice 系数） */
const SIMILARITY_THRESHOLD = 0.5;

/** 字符级 diff 的单侧长度上限：超过则退化为整段删除 + 整段新增 */
const CHAR_DIFF_MAX_LENGTH = 1500;

/**
 * 正文纯文本 → 条款单元序列：第X章 / 第X条行开启新单元；其余行归属当前条
 * （款 / 项为条的从属内容），无当前条时自成段落单元。
 */
export function splitClauses(bodyText: string | null | undefined): ClauseUnit[] {
  if (!bodyText) return [];
  const units: ClauseUnit[] = [];
  for (const rawLine of bodyText.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const chapter = CHAPTER_LABEL.exec(line);
    const article = ARTICLE_LABEL.exec(line);
    if (chapter !== null) {
      units.push({ kind: 'chapter', label: chapter[0], text: line });
    } else if (article !== null) {
      units.push({ kind: 'article', label: article[0], text: line });
    } else {
      const last = units[units.length - 1];
      if (last !== undefined && last.kind === 'article') {
        last.text = `${last.text}\n${line}`;
      } else {
        units.push({ kind: 'paragraph', label: null, text: line });
      }
    }
  }
  return units;
}

/**
 * 两轮正文 → 差异行序列（文档顺序：修改 / 删除按旧版条款顺序穿插在相同
 * 锚点之间，新增行排在所属间隙末尾）。
 */
export function diffNoticeBodies(
  oldBody: string | null | undefined,
  newBody: string | null | undefined,
): DiffRow[] {
  const oldUnits = splitClauses(oldBody);
  const newUnits = splitClauses(newBody);
  const normalized = (unit: ClauseUnit): string => unit.text.replace(/\s+/g, '');
  const anchors = lcsPairs(
    oldUnits.map(normalized),
    newUnits.map(normalized),
    (a, b) => a === b,
  );

  const rows: DiffRow[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const anchor of anchors) {
    resolveGap(rows, oldUnits, oldIndex, anchor.a, newUnits, newIndex, anchor.b);
    rows.push({
      kind: 'same',
      old: oldUnits[anchor.a],
      new: newUnits[anchor.b],
      oldSegments: null,
      newSegments: null,
    });
    oldIndex = anchor.a + 1;
    newIndex = anchor.b + 1;
  }
  resolveGap(rows, oldUnits, oldIndex, oldUnits.length, newUnits, newIndex, newUnits.length);
  return rows;
}

/** 解析两个锚点之间的间隙：同编号优先、相似度次之，剩余删除 / 新增。 */
function resolveGap(
  rows: DiffRow[],
  oldUnits: ClauseUnit[],
  oldStart: number,
  oldEnd: number,
  newUnits: ClauseUnit[],
  newStart: number,
  newEnd: number,
): void {
  const olds = oldUnits.slice(oldStart, oldEnd);
  const news = newUnits.slice(newStart, newEnd);
  if (olds.length === 0 && news.length === 0) return;

  // 1) 同编号条款配对为「修改」（LCS 极大性保证同编号配对的文本必然不同）
  const modified = new Map<number, ClauseUnit>(); // 旧单元索引 → 配对的新单元
  const takenNew = new Set<number>();
  const firstIndexOfLabel = new Map<string, number>();
  news.forEach((unit, index) => {
    if (unit.label !== null && !firstIndexOfLabel.has(unit.label)) {
      firstIndexOfLabel.set(unit.label, index);
    }
  });
  for (const [oldIdx, unit] of olds.entries()) {
    if (unit.label === null) continue;
    const newIdx = firstIndexOfLabel.get(unit.label);
    if (newIdx === undefined || takenNew.has(newIdx)) continue;
    modified.set(oldIdx, news[newIdx]);
    takenNew.add(newIdx);
  }

  // 2) 剩余单元按相似度贪心配对（相似度降序，一对一）
  const pendingOld = olds
    .map((unit, index) => ({ unit, index }))
    .filter(({ index }) => !modified.has(index));
  const pendingNew = news
    .map((unit, index) => ({ unit, index }))
    .filter(({ index }) => !takenNew.has(index));
  const candidates: Array<{ o: number; n: number; score: number }> = [];
  for (const { unit: o, index: oi } of pendingOld) {
    for (const { unit: n, index: ni } of pendingNew) {
      const score = similarity(o.text, n.text);
      if (score >= SIMILARITY_THRESHOLD) candidates.push({ o: oi, n: ni, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.o - b.o || a.n - b.n);
  const usedOld = new Set<number>();
  for (const candidate of candidates) {
    if (usedOld.has(candidate.o) || takenNew.has(candidate.n)) continue;
    modified.set(candidate.o, news[candidate.n]);
    usedOld.add(candidate.o);
    takenNew.add(candidate.n);
  }

  // 3) 输出：修改 / 删除按旧版顺序，新增按新版顺序追加在间隙末尾
  for (const [oldIdx, unit] of olds.entries()) {
    const paired = modified.get(oldIdx);
    if (paired !== undefined) {
      const segments =
        unit.text.length > CHAR_DIFF_MAX_LENGTH || paired.text.length > CHAR_DIFF_MAX_LENGTH
          ? {
              oldSegments: [{ type: 'del' as const, text: unit.text }],
              newSegments: [{ type: 'ins' as const, text: paired.text }],
            }
          : charDiffSegments(unit.text, paired.text);
      rows.push({
        kind: 'modified',
        old: unit,
        new: paired,
        oldSegments: segments.oldSegments,
        newSegments: segments.newSegments,
      });
    } else {
      rows.push({ kind: 'removed', old: unit, new: null, oldSegments: null, newSegments: null });
    }
  }
  for (const [newIdx, unit] of news.entries()) {
    if (!takenNew.has(newIdx)) {
      rows.push({ kind: 'added', old: null, new: unit, oldSegments: null, newSegments: null });
    }
  }
}

/**
 * 字符级 diff：LCS 求两文本的公共字符序列，两侧未匹配的连续字符分别成
 * del / ins 片段，匹配的成 same 片段；再做边界合并 —— 夹在同类变更之间的
 * 极短公共片段并入变更（如被删短语里恰好与新版同字的单字），避免高亮碎裂。
 */
function charDiffSegments(
  oldText: string,
  newText: string,
): { oldSegments: DiffSegment[]; newSegments: DiffSegment[] } {
  const pairs = lcsPairs([...oldText], [...newText], (a, b) => a === b);
  const oldSegments: DiffSegment[] = [];
  const newSegments: DiffSegment[] = [];
  let oi = 0;
  let ni = 0;
  const pushSegment = (list: DiffSegment[], type: DiffSegment['type'], text: string) => {
    const last = list[list.length - 1];
    if (last !== undefined && last.type === type) {
      last.text += text;
    } else {
      list.push({ type, text });
    }
  };
  for (const pair of pairs) {
    if (oi < pair.a) pushSegment(oldSegments, 'del', oldText.slice(oi, pair.a));
    if (ni < pair.b) pushSegment(newSegments, 'ins', newText.slice(ni, pair.b));
    pushSegment(oldSegments, 'same', oldText[pair.a]);
    pushSegment(newSegments, 'same', newText[pair.b]);
    oi = pair.a + 1;
    ni = pair.b + 1;
  }
  if (oi < oldText.length) pushSegment(oldSegments, 'del', oldText.slice(oi));
  if (ni < newText.length) pushSegment(newSegments, 'ins', newText.slice(ni));
  return {
    oldSegments: coalesceShortCommons(oldSegments, 'del'),
    newSegments: coalesceShortCommons(newSegments, 'ins'),
  };
}

/** 变更合并阈值：夹在同类变更之间、不超过该长度的公共片段并入变更 */
const COALESCE_MAX_COMMON = 2;

/** 把夹在两个同类变更段之间的极短公共片段并入变更（提升高亮可读性）。 */
function coalesceShortCommons(
  segments: DiffSegment[],
  changeType: 'del' | 'ins',
): DiffSegment[] {
  const merged = segments.map((segment) => ({ ...segment }));
  for (let i = 1; i < merged.length - 1; i += 1) {
    const segment = merged[i];
    if (
      segment.type === 'same' &&
      segment.text.length <= COALESCE_MAX_COMMON &&
      merged[i - 1].type === changeType &&
      merged[i + 1].type === changeType
    ) {
      merged[i - 1].text += segment.text + merged[i + 1].text;
      merged.splice(i, 2);
      i -= 1;
    }
  }
  return merged;
}

/** LCS：返回全部匹配对（按双方索引升序）。调用方保证规模有界（条款单元数 / 字符数上限）。 */
function lcsPairs<T>(
  a: T[],
  b: T[],
  equal: (x: T, y: T) => boolean,
): Array<{ a: number; b: number }> {
  const rows = a.length;
  const cols = b.length;
  if (rows === 0 || cols === 0) return [];
  // 全量 DP 表：table[i * (cols + 1) + j] = LCS(a[i..], b[j..])。
  // 规模有界（单元 diff 行数小；字符 diff 有 CHAR_DIFF_MAX_LENGTH 上限），
  // 换取 O(rows + cols) 的确定性前向重建。
  const table = new Int32Array((rows + 1) * (cols + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i * (cols + 1) + j] = equal(a[i], b[j])
        ? table[(i + 1) * (cols + 1) + j + 1] + 1
        : Math.max(table[(i + 1) * (cols + 1) + j], table[i * (cols + 1) + j + 1]);
    }
  }
  const pairs: Array<{ a: number; b: number }> = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (equal(a[i], b[j])) {
      pairs.push({ a: i, b: j });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * (cols + 1) + j] >= table[i * (cols + 1) + j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/** 相似度：字符二元组 Dice 系数（单字文本以该字为唯一二元组），0 ~ 1。 */
function similarity(a: string, b: string): number {
  const na = a.replace(/\s+/g, '');
  const nb = b.replace(/\s+/g, '');
  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1;
  const gramsA = bigrams(na);
  const gramsB = bigrams(nb);
  let overlap = 0;
  for (const [gram, count] of gramsA) {
    const other = gramsB.get(gram);
    if (other !== undefined) overlap += Math.min(count, other);
  }
  return (2 * overlap) / (gramTotal(gramsA) + gramTotal(gramsB));
}

function bigrams(text: string): Map<string, number> {
  const grams = new Map<string, number>();
  if (text.length === 1) {
    grams.set(text, 1);
    return grams;
  }
  for (let i = 0; i < text.length - 1; i += 1) {
    const gram = text.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

function gramTotal(grams: Map<string, number>): number {
  let total = 0;
  for (const count of grams.values()) total += count;
  return total;
}
