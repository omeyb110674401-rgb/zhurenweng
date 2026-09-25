/**
 * 修正案"改动点"的计数与覆盖度（issue #76 第 2 刀）—— 纯函数。
 *
 * 为什么要有这一层：读者看到一张"改动点表格"，第一个问题应该是
 * **"这是全部吗"**。答案不能来自模型的自我申报（模型说"以上为主要内容"这句话
 * 一点信息量都没有），只能来自本站自己在正文里数出来的改动表述条数 vs 页面列出的条数。
 * 于是页面能给出一行可核对的话："正文里检测到 37 处修改表述，本站列出 31 处" ——
 * 少的那些就是喂给模型的窗口没装下的部分（单份附件窗口 8,000 字，而中位附件就有 7,476 字、
 * p90 46,902 字），这行数字同时也是"要不要为此上多轮调用"的唯一诚实依据。
 */
import { AMENDMENT_TEXT_MARKERS } from './notice-genre.ts';

/** 改动类型：与页面上的中文标签一一对应（模型给的类型只用于分类展示，不进判据）。 */
export type ChangeKind = 'modify' | 'add' | 'delete' | 'renumber' | 'other';

export const CHANGE_KIND_LABELS: Record<ChangeKind, string> = {
  modify: '修改',
  add: '新增',
  delete: '删除',
  renumber: '条序调整',
  other: '其他',
};

/**
 * 每类改动在官方对照文字里的典型写法。
 * 刻意只认"官方写法"：这些模式同时也是判体裁的词（见 AMENDMENT_TEXT_MARKERS），
 * 一套词表两个用途，不会出现"判成修正案但改动点数是 0"的自相矛盾页面。
 */
const KIND_PATTERNS: Record<Exclude<ChangeKind, 'other'>, RegExp> = {
  modify: /修改为|修改如下|作.{0,4}修改/g,
  add: /增加一条|新增.{0,8}条/g,
  delete: /删去|删除/g,
  renumber: /作为第[一二三四五六七八九十百零两]{1,6}条|顺序作.{0,4}调整/g,
};

export interface ChangeMarkerCount {
  /** 正文里检测到的改动表述总数（各类相加） */
  total: number;
  byKind: { modify: number; add: number; delete: number; renumber: number };
}

/** 数一遍正文里的改动表述。正则带 g，每次都用新副本，不吃 lastIndex。 */
export function countChangeMarkers(text: string): ChangeMarkerCount {
  const source = text ?? '';
  const byKind = { modify: 0, add: 0, delete: 0, renumber: 0 };
  if (source === '') return { total: 0, byKind };
  for (const [kind, pattern] of Object.entries(KIND_PATTERNS)) {
    const key = kind as keyof typeof byKind;
    // 同一处文字可能被多个模式各数一次（"删去…增加一条作为第X条"就是一句三处），
    // 这正是我们要的：读者关心的是"有多少处表述要解释"，不是"改了几条"。
    byKind[key] = [...source.matchAll(new RegExp(pattern.source, 'g'))].length;
  }
  return { total: byKind.modify + byKind.add + byKind.delete + byKind.renumber, byKind };
}

export interface CoverageVerdict {
  state: 'complete' | 'partial' | 'no_markers';
  detail: string;
}

/**
 * 页面那行覆盖度说明。
 *
 * 三种情况分开，因为它们对读者意味着完全不同的话：
 * - `complete`：列出的不少于正文检测到的 ⇒ "已列出全部 N 处"；
 * - `partial`：列得少 ⇒ 明说"还有 M−N 处没列出（本站读到的那一截里没有）"，
 *   这是**窗口不够**的直接证据，不粉饰成"以上是主要内容"；
 * - `no_markers`：正文里一个改动表述都没检测到（体裁是靠标题判的）⇒ 不给数字，
 *   写"未在附件正文里检测到成文的修改表述"，别让读者以为"0 处改动=这条没改什么"。
 */
export function changeCoverageVerdict(listed: number, markers: ChangeMarkerCount): CoverageVerdict {
  if (markers.total === 0) {
    return { state: 'no_markers', detail: '未在附件正文里检测到成文的修改表述（按标题判为修正案）' };
  }
  if (listed >= markers.total) {
    return { state: 'complete', detail: `已列出正文里检测到的全部 ${markers.total} 处修改表述` };
  }
  return {
    state: 'partial',
    detail: `正文里检测到 ${markers.total} 处修改表述，本页列出 ${listed} 处 —— 其余的不在本站读到的那一截文本里`,
  };
}

/**
 * 编制说明的"小节数"（issue #76 第 3 刀）：说明类文件自带分层标题
 * （一、项目概况 / 1 编制背景 / （二）任务来源 / 第二章 …），数它们就是分母。
 *
 * 这是**启发式**，不是解析器：官方文件的层级写法不统一，数多了或少了都可能。
 * 所以页面那句话要写成"检测到约 N 个小节标题"，不能写成"共 N 节"——
 * 一个假装精确的数字比一个带"约"字的数字更坏。
 */
/**
 * 说明类文件的分层小标题形状（issue #76 第 3 刀）。
 *
 * 只用字符类写，不用 \d \s 这类转义：这段正则要为"一、项目概况 / 1.2 任务来源 /
 * （二）编制过程 / 第二章 必要性"四种官方写法各认一次，转义一多就容易在改的时候写错。
 */
const SECTION_HEAD_RE = /^ *(?:[一二三四五六七八九十]{1,3}[、.．]|[0-9]{1,2}([.][0-9]{1,2}){0,2}[、.． ]|[（(][一二三四五六七八九十]{1,3}[）)] *|第[一二三四五六七八九十]{1,3}[章节部分篇] *)[^ ].{0,40}$/;

/** 说明里被认作小节标题的那些行（逐字）。计数与测试共用这一份判据。 */
export function explanationSectionLines(text: string): string[] {
  if (!text) return [];
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 1 && line.length <= 46 && SECTION_HEAD_RE.test(line));
}

export function countExplanationSections(text: string): number {
  return explanationSectionLines(text).length;
}

/** 说明要点的覆盖度那句话（与改动点那条同构，但措辞带"约"，理由见上面的启发式说明）。 */
export function explanationCoverageVerdict(
  listed: number,
  sections: number,
): CoverageVerdict {
  if (sections === 0) {
    return { state: 'no_markers', detail: '未在这份说明里检测到分层小标题' };
  }
  if (listed >= sections) {
    return { state: 'complete', detail: `已列出检测到的约 ${sections} 个小节` };
  }
  return {
    state: 'partial',
    detail: `这份说明检测到约 ${sections} 个小节，本页列出 ${listed} 个 —— 其余的不在本站读到的那一截里`,
  };
}

/** 反查用得到的词表导出位（避免调用方各自抄一遍常量）。 */
export { AMENDMENT_TEXT_MARKERS };
