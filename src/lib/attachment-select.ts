/**
 * 附件选取与截取（issue #57）—— 一条公示往往带 5–11 个附件，而摘要预算只装得下
 * 两三个文件的几千字，所以「挑哪个文件」和「从文件里取哪一段」都是产品判断，
 * 不是实现细节。这里把两条判断写成纯函数，任务层与审计脚本共用同一套口径。
 *
 * 为什么按文件名打分而不等内容再看：下载是有代价的（per-host 3 秒间隔 + 每轮 ≤120 个
 * 文件），一条公示最多取 3 个。名字是**下载前**唯一有的信号，而政务附件命名高度规律
 * （「XX（草案征求意见稿）.pdf」「XX 意见征求表.doc」），够用。
 *
 * 为什么不把整篇塞进提示词：一份 60 页标准的**前** 12k 字是封面 + 目录 + 前言，
 * 系统性错过「适用范围」—— 而那正是「影响谁」唯一可能的答案来源。
 */

/** 一条公示一轮最多下载几个附件。 */
export const MAX_FILES_PER_NOTICE = 3;

/** 单个附件进提示词的字数上限（配合 MAX_FILES_PER_NOTICE 里的前 2 个，提示总量约 28k 字）。 */
export const PROMPT_CHARS_PER_ATTACHMENT = 8_000;

/** 一条公示累计取到这么多汉字就提前停 —— 再多对摘要没有增量信息。 */
export const TARGET_TOTAL_CJK_CHARS = 12_000;

/** 抽出的文本汉字数低于它，判「没有条文正文」（空白意见表就是这一类）。 */
export const MIN_DRAFT_CJK_CHARS = 400;

/** 结构锚点前后各取多少字。300 字够装下一条完整条文，又不至于把整篇拖进来。 */
export const ANCHOR_WINDOW_CHARS = 300;

/**
 * 文件名打分。命中即 +3 的是「这就是条文本身」，-4 的是「填了寄回去的表」——
 * 后者体积往往最大（2.2MB 的意见征求表），按大小排序会把它排第一，所以必须给负分。
 */
const STRONG_DRAFT = [
  '草案',
  '征求意见稿',
  '标准文本',
  '正文',
  '办法',
  '规定',
  '实施细则',
  '起草说明',
  '编制说明',
];
const WEAK_DRAFT = ['通知', '方案'];
/**
 * 名字里带这些词的文件不是条文散文，而是**要人填的东西**。
 *
 * 「申报书 / 报名表」这一族是 2026-09-22 从线上补的：市监总局征集食品补充检验方法时，
 * 随文只有 `食品补充检验方法立项申报书.docx` 一类空白模板，它们各占了 3 个下载名额里的
 * 一个，抽出 587 / 624 个汉字的栏目骨架喂给模型 —— 那是表格的表头，不是条文。
 */
const NOT_DRAFT_TEXT = ['回执', '反馈表', '意见表', '征求表', '填写表', '模板', '登记表', '汇总表', '申报书', '报名表', '附图', '照片'];

/** 扩展名先验：pdf / docx 是条文载体的高概率形态，doc 次之。 */
const EXTENSION_PRIOR: Record<string, number> = { pdf: 2, docx: 2, doc: 1 };

/**
 * 一眼就不是条文散文的容器。xlsx 里也可能有清单，但抽文字要另写一套解析，
 * 而且这类文件通常是「填报表」—— 与 NOT_DRAFT_TEXT 同一族。
 */
const SKIP_EXTENSIONS = ['zip', 'rar', '7z', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'ofd', 'caj', 'txt', 'md', 'jpg', 'jpeg', 'png', 'gif', 'bmp'];

/** 结构锚点之外还要给模型的章节骨架：最多 12 行、900 字（先占住预算再让窗口排队）。 */
const OUTLINE_MAX_LINES = 12;
const OUTLINE_MAX_CHARS = 900;

/**
 * 结构锚点：出现这些片段的位置，周围的文字对摘要最有信息量。
 *
 * 「适用范围 / 本文件适用于」单独值得注意 —— 它是 `who` 唯一可能的来源，
 * 而它通常出现在第二章，也就是整篇文档的前 12k 字之外。
 */
const STRUCTURE_ANCHORS = [
  '适用范围',
  '本文件适用于',
  '本办法适用于',
  '适用于',
  '起草说明',
  '编制说明',
  '征求意见',
  '第一条',
  '第二条',
  '第三条',
  '第一章',
  '第二章',
  '各单位、各',
];

function extensionOf(name: string): string {
  const trimmed = name.trim();
  const match = /\.([a-z0-9]{1,5})$/.exec(trimmed);
  return match === null ? '' : match[1].toLowerCase();
}

/**
 * 文件名打分（分越高越像条文）。
 *
 * 分数本身不是契约，**排序**才是：同一条公示里「草案征求意见稿」要排在「意见征求表」前面。
 */
export function scoreAttachmentName(name: string): number {
  const text = name.trim();
  if (text === '') return 0;
  let score = EXTENSION_PRIOR[extensionOf(text)] ?? 0;
  if (STRONG_DRAFT.some((keyword) => text.includes(keyword))) score += 3;
  else if (WEAK_DRAFT.some((keyword) => text.includes(keyword))) score += 1;
  if (NOT_DRAFT_TEXT.some((keyword) => text.includes(keyword))) score -= 4;
  return score;
}

/** 这个扩展名的附件本轮根本不该下载。 */
export function shouldSkipByExtension(name: string): boolean {
  return SKIP_EXTENSIONS.includes(extensionOf(name));
}

export interface AttachmentCandidate {
  name: string;
  url: string;
  /** 打分结果，任务层写日志与审计脚本按源出数时要用 */
  score: number;
}

/**
 * 从一条公示的附件清单里挑出本轮要下载的，按分数降序。
 *
 * 同分时保持清单原序（稳定排序）—— 官方页面上的排列顺序通常就是「正文在前、表格在后」。
 */
/** 附件在这条公示里扮演的角色（issue #76 第 3 刀）。 */
export type AttachmentRole = 'draft' | 'explanation' | 'other';

/**
 * 说明类文件的典型名字。
 *
 * 刻意不收「说明」这个单字 —— 它出现在"使用说明""填写说明""代号说明"里，
 * 那些不是对草案的解读，把它们当说明喂进去会挤掉真正的条文。
 */
const EXPLANATION_NAMES = ['编制说明', '起草说明', '修订说明', '修改说明', '编制解释'];

/** 角色由文件名判：抽取任务按正文内容重算体裁时也用这一份定义，别两处各写一套。 */
export function attachmentRole(name: string): AttachmentRole {
  const text = (name ?? '').trim();
  if (EXPLANATION_NAMES.some((word) => text.includes(word))) return 'explanation';
  if (scoreAttachmentName(text) >= 3) return 'draft';
  return 'other';
}

export function selectAttachmentCandidates(
  items: { name: string; url: string }[],
  limit = MAX_FILES_PER_NOTICE,
): AttachmentCandidate[] {
  const ranked = items
    .filter((item) => !shouldSkipByExtension(item.name))
    .map((item) => ({ name: item.name, url: item.url, score: scoreAttachmentName(item.name) }))
    .sort((a, b) => b.score - a.score);
  const chosen = ranked.slice(0, limit);
  // 给说明留一位（issue #76 第 3 刀）：生产实测有 8 份编制说明因为"一条公示附件
  // 多过 3 个名额"而压根没被下载。这里换掉的是**分数最低的最后一个名额** ——
  // 并列时清单原序在前（官方页面通常正文在前、表格在后），所以被挤掉的不会是条文。
  if (limit >= 2 && !chosen.some((item) => attachmentRole(item.name) === 'explanation')) {
    const missing = ranked.find((item) => attachmentRole(item.name) === 'explanation' && !chosen.includes(item));
    // 换进来的前提：换完至少还留着一份条文。为了说明把条文全挤掉是本末倒置 ——
    // 说明是解释文本，读者要判断的规定仍在条文里。
    if (missing) {
      const rest = chosen.slice(0, -1);
      if (rest.some((item) => attachmentRole(item.name) === 'draft')) {
        chosen.pop();
        chosen.push(missing);
      }
    }
  }
  return chosen;
}

/** 汉字数（含中日韩统一表意文字与扩展区 A）。用来判「有没有条文正文」。 */
export function countCjk(text: string): number {
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x3400 && code <= 0x9fff) count += 1;
    else if (code >= 0xf900 && code <= 0xfaff) count += 1;
    else if (code >= 0x20000 && code <= 0x2ebef) count += 1;
  }
  return count;
}

/** 抽出的文本到底算不算「有条文」。空白表的判据在解析后、零成本，不必再看文件名。 */
export function hasDraftText(text: string): boolean {
  return countCjk(text) >= MIN_DRAFT_CJK_CHARS;
}

interface Span {
  start: number;
  end: number;
}

/** 锚点窗口重叠时并成一段，避免出现「同一句话出现两次」的重复文字。 */
function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    // 相邻窗口重叠或首尾相接时并成一段，避免出现「同一句话出现两次」的重复文字
    if (last !== undefined && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function findAnchorSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const anchor of STRUCTURE_ANCHORS) {
    let from = 0;
    // 每个锚点最多取前 3 次出现：长文档里「适用于」会出现几十次，
    // 全取的话窗口覆盖整篇，截取就退化成了「不截」。
    for (let hit = 0; hit < 3; hit += 1) {
      const at = text.indexOf(anchor, from);
      if (at < 0) break;
      spans.push({
        start: Math.max(0, at - ANCHOR_WINDOW_CHARS),
        end: Math.min(text.length, at + anchor.length + ANCHOR_WINDOW_CHARS),
      });
      from = at + anchor.length;
    }
  }
  return mergeSpans(spans);
}

/** 整段里挖掉若干已覆盖区间，剩下的按文档顺序给出（`covered` 必须已按 start 升序）。 */
function subtractSpans(whole: Span, covered: Span[]): Span[] {
  const gaps: Span[] = [];
  let cursor = whole.start;
  for (const span of covered) {
    if (span.start > cursor) gaps.push({ start: cursor, end: span.start });
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < whole.end) gaps.push({ start: cursor, end: whole.end });
  return gaps;
}

/** 章节标题骨架：截取之后模型仍不知道全文结构，补这几行就有了「共六章三十条」的概念。 */
function outlineLines(text: string, limit: number): string {
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (/^第[一二三四五六七八九十百零〇\d]+[章节编部分]/.test(trimmed) || /^[一二三四五六七八九十]+、/.test(trimmed)) {
      lines.push(trimmed.slice(0, 60));
      if (lines.length >= limit) break;
    }
  }
  return lines.join('\n');
}

const ELLIPSIS = '\n……（中间省略）……\n';
const OUTLINE_HEADER = '\n【全文结构（标题骨架）】\n';

/**
 * 结构感知截取：**先**按锚点取窗口（保证「适用范围」一定在服务到的范围里），剩余预算
 * 再按文档顺序补满，最后补章节骨架。
 *
 * 为什么不是 `text.slice(0, 8000)`：一份 60 页标准的前 8000 字是封面 + 目录 + 前言，
 * 而「适用范围」通常在第二章 —— 恰恰是 `who`（影响谁）唯一可能的来源。截错位置等于
 * 白下载了一次。
 * 为什么要拿锚点之外的文字补满：三个窗口的量级只有一千字左右，剩下七千字预算不用等于
 * 白花钱；锚点先取保证「补满」不会把关键段挤出去。
 * 为什么要省略标记：摘要的引用要能逐字回查（#57 的出处判定）。拼接过的文本如果不标记，
 * 模型会以为它是连续原文，把两段话缝成一句「原文」。
 */
export function excerptForPrompt(text: string, maxChars = PROMPT_CHARS_PER_ATTACHMENT): string {
  if (text.length <= maxChars) return text;

  // 骨架先占住它那份预算：它只有一二十行，却决定模型知不知道「全文共六章三十条」。
  const outline = outlineLines(text, OUTLINE_MAX_LINES);
  const outlineBudget = outline === '' ? 0 : Math.min(OUTLINE_MAX_CHARS, Math.floor(maxChars / 8));
  const bodyBudget = maxChars - outlineBudget - OUTLINE_HEADER.length - ELLIPSIS.length;

  const pieces: Span[] = [];
  let used = 0;

  /** 取一段原文；返回是否整段都装下了。 */
  const take = (span: Span): boolean => {
    const budget = bodyBudget - used - (pieces.length > 0 ? ELLIPSIS.length : 0);
    if (budget <= 0) return false;
    const length = Math.min(span.end - span.start, budget);
    pieces.push({ start: span.start, end: span.start + length });
    used += length + (pieces.length > 1 ? ELLIPSIS.length : 0);
    return length === span.end - span.start;
  };

  const anchors = findAnchorSpans(text);
  for (const span of anchors) {
    if (!take(span)) break;
  }
  // 补满：按文档顺序取锚点没覆盖的部分。锚点命中即止，所以这两组区间不相交，
  // 不会出现「同一句话出现两遍」。
  for (const gap of subtractSpans({ start: 0, end: text.length }, anchors)) {
    if (!take(gap)) break;
  }

  let out = pieces
    .sort((a, b) => a.start - b.start)
    .map((span) => text.slice(span.start, span.end))
    .join(ELLIPSIS);

  if (outlineBudget > 0) out += ELLIPSIS + OUTLINE_HEADER + outline.slice(0, outlineBudget);
  return out.slice(0, maxChars);
}
