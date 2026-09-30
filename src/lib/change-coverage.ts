import { coverageGapAttribution, type CoverageVerdict } from './explanation-coverage.ts';
import type { FeedReport } from './attachment-feed.ts';

/**
 * 「改了哪几处」的覆盖度与改动类型（issue #86 第 2 刀）。
 *
 * **这个文件是一份重建**：同样的内容曾存在于 `amendment-coverage.ts`，2026-09-27 随整个
 * 「改动点」功能删除（issue #85）。删它的判据是"它从来没有产出过"——而那个判据**是错的**：
 * 86 号文档第九节实测出，那 5 条候选**从来没有被带这段代码的版本重跑过**（两批不同的"5 条"
 * 被当成了一批），用旧提示词重跑金丝雀一次就吐出 10 条、8 条通过逐字反查。
 * 所以这一段是**带着实测回来的**，而下面这几条判据本身没有问题、当年也测过。
 *
 * 覆盖度这一层为什么必须有：读者看到一张"改了哪几处"的表，第一个问题应该是**"这是全部吗"**。
 * 答案不能来自模型的自我申报，只能来自本站自己在正文里数出来的改动表述数 vs 表里列出的条数。
 *
 * **2026-09-28 改口**：原先这句话把差值归给"其余的不在本站读到的那一截文本里"，而那是**我们
 * 不知道的事**。拿公路法那条实测：正文合计 1,992 汉字、整份都在重档窗口内，同一份输入跑四遍
 * （两条臂各两遍）列出的行数分别是 8 / 2 / 3 / 8 —— 差额主要来自**模型没逐条写出来**，
 * 而不是"我们没读到"。原来那句话在这种情形下**是假的**，而它读起来像一句可核对的交代。
 * 现在只说我们真的掌握的：分母是什么（本站读到的全部附件正文）、表里为什么只有这些
 * （模型写出且逐字对得回原文），以及差额能归给谁。
 *
 * **2026-09-28 §19.4 收尾：差额归给谁不再靠猜。** 读者侧现在拿得到 `FeedReport`
 * （`getNoticeSummary` 取 `summary_diagnostics_json` → 详情页 → `SummaryView`），
 * 于是两句交代共用 `explanation-coverage.ts` 的 `coverageGapAttribution`：
 * **只有喂入清单真的报了缺口**（某一份被截 / 某一份一个字都没喂进去）时，"差额可能出在
 * 没喂进去的那一截上"才允许出现；清单说每一份都整份进了窗口就只归给模型没写；
 * 没有清单（v1 的存量行）照实说给不出可核对的答案。**两处必须一起改** —— 说法不一致
 * 会让读者以为两栏的可信度不同（见 `explanation-coverage.ts` 文件头）。
 */

/** 改动类型（issue #76；`other` 是兜底桶）。展示名与页面标签一一对应。 */
export type ChangeKind = 'modify' | 'add' | 'delete' | 'renumber' | 'other';

/**
 * 类型白名单——**唯一一份**：`ports.ts` 的字段类型与适配器的归一化都从它来。
 * 抄成两份的话，漂移的表现是"模型给了一个合法值却被判成 other"，而页面上只是标签不对，没人会发现。
 */
export const CHANGE_KINDS: readonly ChangeKind[] = ['modify', 'add', 'delete', 'renumber', 'other'];

export const CHANGE_KIND_LABELS: Record<ChangeKind, string> = {
  modify: '修改',
  add: '新增',
  delete: '删除',
  renumber: '条序调整',
  other: '其他',
};

/**
 * 正文里**数得到**的改动表述类型（`other` 不在其中：它是模型给的分类兜底桶，
 * 不是任何一种公文写法）。顺序 = `countChangeMarkers` 的汇总顺序，也是页面上的展示顺序。
 */
export const CHANGE_MARKER_KINDS = ['modify', 'add', 'delete', 'renumber'] as const;

/** 一处在正文里数到的改动表述的类型 */
export type ChangeMarkerKind = (typeof CHANGE_MARKER_KINDS)[number];

/**
 * 各类改动在正文里的写法。刻意写成"官方会怎么写"，不是"我们想找什么"：
 * 「修改为 / 修改如下 / 删去 / 增加一条 / 作为第X条」都是公文的固定说法。
 */
const KIND_PATTERNS: Record<ChangeMarkerKind, RegExp> = {
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

/** 一处在正文里数到的改动表述（位置由 `findChangeMarkers` 给，供探针与"按处列表"用）。 */
export interface ChangeMarker {
  kind: ChangeMarkerKind;
  /** 命中在原文里的起始下标 */
  index: number;
  /** 命中的字面（如「修改为」「增加一条」） */
  text: string;
}

/**
 * 把正文里的改动表述**逐处**找出来（位置 + 类型 + 字面）。
 *
 * 为什么把位置也交出来（2026-09-28）：`countChangeMarkers` 的 `total` 是**覆盖度的分母**，
 * 不是"改了几条" —— 同一句话可能被多个模式各数一次（"删去…增加一条作为第X条"就是一句三处）。
 * 这个区别在纸上很清楚，但用它的人（我）在写"把数到的每一处都列成行"这个方案时就忘了，
 * 差一点让页面把一句话印成三行。所以把位置与字面暴露出来：以后要按处列表、或是要核对
 * "分母里这 14 处到底落在哪几句上"，都从这一份实现里取，不再各自抄正则。
 */
export function findChangeMarkers(text: string): ChangeMarker[] {
  const source = text ?? '';
  if (source === '') return [];
  const found: ChangeMarker[] = [];
  for (const [kind, pattern] of Object.entries(KIND_PATTERNS)) {
    for (const match of source.matchAll(new RegExp(pattern.source, 'g'))) {
      found.push({
        kind: kind as ChangeMarker['kind'],
        index: match.index ?? 0,
        text: match[0],
      });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/**
 * 数一遍正文里的改动表述。判据只有 `findChangeMarkers` 一处，这里只做汇总 ——
 * 从前它自己抄了一遍正则，多一份就多一次漂移的机会（两份词表打架的教训见 #79）。
 */
export function countChangeMarkers(text: string): ChangeMarkerCount {
  const byKind = { modify: 0, add: 0, delete: 0, renumber: 0 };
  const found = findChangeMarkers(text);
  for (const marker of found) byKind[marker.kind] += 1;
  return {
    total: found.length,
    byKind,
  };
}

/**
 * 「改了哪几处」的覆盖率。
 *
 * 分母由调用方按**全部附件正文**数（不是喂进模型的那一截）—— 拿喂进去的那一截数分母，
 * 窗口外的改动永远不会出现在"还差多少"那句话里，那是自证（issue #76 的原始设计）。
 *
 * 三种状态：数不到改动表述 / 列够了 / 列得比数到的少。第三种**不许替差额认领原因**：
 * 我们只知道自己数了多少、列了多少，以及列出来的每一行都过了逐字反查 —— 剩下的既可能是
 * 模型没写，也可能是我们没读到，而**只有本轮的喂入清单能区分这两者**（详见文件头那条实测）。
 *
 * `feed`（可选，issue #86 §19.4）：产出这份摘要的那次调用喂了什么。给了就按清单说 ——
 * 清单没报缺口时**不许**再提"没读到"；不给（v1 的存量行）照实说给不出可核对的答案。
 */
export function changeCoverageVerdict(
  listed: number,
  markers: ChangeMarkerCount,
  feed?: FeedReport | null,
): CoverageVerdict {
  if (markers.total === 0) {
    return { state: 'no_markers', detail: '附件正文里没有数到成文的修改表述，这一栏给不出「共几处」' };
  }
  if (listed >= markers.total) {
    return { state: 'complete', detail: `已列出正文里数到的全部 ${markers.total} 处改动字眼` };
  }
  return {
    state: 'partial',
    detail:
      `正文里按改动字眼数到 ${markers.total} 处，本页列出 ${listed} 处 —— ` +
      '分母按本站读到的全部附件正文数（是**字眼计数**，不是逐条核过的改动清单）；' +
      '表里只列模型写出、且引用能逐字对回原文的那些。' +
      coverageGapAttribution(feed, '改动字眼'),
  };
}

/**
 * 「改了哪几处」那张表里的一行是**怎么来的**（issue #86 第二十节第 3 小节）。
 *
 * 为什么要多这一层：这张表原先**只有模型写出来的行**，于是同一个输入跑两遍可以只有 2 行
 * （实测 8 / 2 / 3 / 8），而读者从页面上**看不出来**少了什么 —— 覆盖度那行只说"检测到 14 处、
 * 列出 2 处"，读者没有任何办法把缺的那些找出来。现在**行由程序定**：每一句官方条目一行，
 * 模型写得出可核对说明的照旧渲染，写不出的那一行只报事实。抖动于是从
 * "表少了一半"（不可见）变成"某几行的说明暂时缺着"（可见）。
 *
 * 两个来源的证据地位不同，所以用联合类型分开，而不是塞一个可空的 `text`：
 * - `described`：指向 `QuotedSummary.changes` 的下标。那一行经过逐字反查，是事实 + 说明；
 * - `fact`：程序自己数出来的（原句 + 数到的改动表述类型），**没有**模型的说明 ——
 *   页面据 `type` 决定"改了什么"那一格印什么，不靠"text 是不是空串"来猜。
 *
 * 只存下标不存文本：`described` 那一行的每个字在 `changes` 里已经有了，复制一份就是给
 * "同一件事两处记载、迟早分家"留门。
 */
export type ChangeTableEntry =
  | { type: 'described'; change: number }
  | {
      type: 'fact';
      clause: string;
      kinds: ChangeMarkerKind[];
      /**
       * 这一句里数到的**字面**（如「修改为」「删去」，去重、按出现顺序）。
       *
       * 2026-09-30 加：完整表上线当天在生产上量到，58 处删除类命中里 **48 处是条文里的动词**
       * 或对照表单元格（"采取删除、屏蔽、断开链接…"、"违规删除…信用信息"、"本标准 删除 删除"）。
       * 也就是说我们数的是**字眼**，不是"这一定是一处改动"。那一栏的措辞必须照着这个事实说：
       * 页面上它印成「本站在这一句里数到了「删除」，但没能给出可核对的说明」—— 读者一眼就能
       * 核对我们数到的是什么（原句就印在右边），而不是被我们告知"这里有一处改动"。
       *
       * 旧行没有这个字段：渲染时退回按 `kinds` 的展示名说（「删除」这类字眼），
       * 于是**不需要重跑**那些已经落库的摘要。
       */
      marks: string[];
      sentence: string;
    };

/**
 * 只报事实那一行的「改了什么」格该印什么（页面、验收门与探针**共用一份措辞**）。
 *
 * 措辞照**我们真的做的事**说：数到的是字眼，不是"这里有一处改动"。2026-09-30 生产实测，
 * 58 处删除类命中里 48 处是条文里的动词（"采取删除、屏蔽…"）或修订对照表的单元格
 * （"本标准 删除 删除"）—— 写成"检测到改动"就是替文件下了一个我们没核过的结论。
 * 原句就印在同一行的右边，读者一眼能核对我们数到的是什么。
 *
 * 旧落库行没有 `marks`（那是后加的字段）⇒ 退回按类型名说（「删除」这类字眼），
 * 于是那些行**不需要重跑**也能拿到诚实措辞。
 */
export function changeFactNote(entry: {
  kinds: ChangeMarkerKind[];
  marks?: string[] | null;
}): string {
  const marks = entry.marks ?? [];
  const subject =
    marks.length > 0
      ? marks.map((mark) => `「${mark}」`).join('、')
      : `「${entry.kinds.map((kind) => CHANGE_KIND_LABELS[kind]).join('、')}」这类字眼`;
  return `本站在这一句里数到了${subject}，但没能给出可核对的说明`;
}

/** 「改了哪几处」的整张表：程序定的行序 + 几个不单独成行的标题句。 */
export interface ChangeTable {
  entries: ChangeTableEntry[];
  /**
   * 命中改动表述、但按标题判据**不单独成行**的句子数。
   *
   * 存下来是为了让页面那句交代说得完整：只说"列出 N 行"而不提这几句，
   * 读者无法判断表是不是全的（而"检测到 14 处"这个分母里本来就混着标题 —— 见 §20.1）。
   */
  headers: number;
}

/** 那张表要对读者交代的东西（`detail` 是页面与验收脚本共用的一句话）。 */
export interface ChangeTableNote {
  /** 表里列出的行数 */
  rows: number;
  /** 其中只报了事实（模型没写出可核对说明）的行数 */
  factOnly: number;
  detail: string;
}

/**
 * 「改了哪几处」那张表对读者的交代（issue #86 第二十节第 3 小节）。
 *
 * **刻意不复用 `CoverageVerdict`**：那个类型里的 `partial` 意思是"列得比数到的少"，
 * 而这一版表**不可能少列**（行由程序定）。缺的只可能是某几行的说明 —— 两件事共用一个状态名，
 * 下一个读代码的人迟早把它们当成一件事（"两份词表打架"是 #79 的教训）。
 *
 * 数字只报我们真的掌握的：分母（本站读到的全部附件正文里数到几处）、行数、其中几行有说明、
 * 几句是标题。**不报"改了几条"** —— 同一句里可以数出三处（实测：一句总述里三个"修改为"），
 * 分母不是条款数。
 *
 * `feed`（可选，issue #86 §19.4）只在**真有"只报事实"的行**时才用得上：那几行的说明为什么缺，
 * 得说清是"没喂进去"还是"模型没写"——判据与编制说明那一栏共用
 * （`explanation-coverage.ts` 的 `coverageGapAttribution`）。一行都不缺时不提这个话题。
 */
export function changeTableNote(
  input: {
    markers: number;
    rows: number;
    described: number;
    factOnly: number;
    headers: number;
  },
  feed?: FeedReport | null,
): ChangeTableNote {
  const rows = input.rows;
  const factOnly = input.factOnly;
  if (input.markers === 0) {
    return { rows, factOnly, detail: '附件正文里没有数到成文的修改表述，这一栏给不出「共几处」' };
  }
  /**
   * 分母的说法必须与事实相符（2026-09-30 改口）：我们数的是**字眼**，不是"文件里真的有 N 处改动"。
   * 生产实测：58 处删除类命中里 48 处是条文里的动词或对照表单元格。原先那句
   * 「正文里检测到 N 处修改表述」把"匹配到字眼"说成了"检测到改动"——
   * 而读者会据此以为下面那些行都真的是改动。
   */
  const parts = [
    `正文里按「修改为 / 删去 / 增加一条 / 作为第X条」这类字眼数到 ${input.markers} 处；` +
      `本页按句归并成 ${rows} 行`,
  ];
  if (factOnly === 0) {
    parts.push(`，${input.described} 行都附了逐字原文与可核对的说明`);
  } else {
    parts.push(
      ` —— ${input.described} 行附了逐字原文与可核对的说明，` +
        `${factOnly} 行只报「这一句里数到了改动字眼」这一事实（原句照登，请自己判断）`,
    );
  }
  if (input.headers > 0) {
    parts.push(`；另有 ${input.headers} 句是小标题（不含条款内容），不单独列行`);
  }
  parts.push('。分母按本站读到的全部附件正文数，它是**字眼计数**，不是逐条核过的改动清单。');
  // 缺的只是"某几行的说明"⇒ 按喂入清单交代那几行的说明能归给谁（没有缺口就不提这一层）
  if (factOnly > 0) parts.push(coverageGapAttribution(feed, '改动字眼'));
  return { rows, factOnly, detail: parts.join('') };
}
