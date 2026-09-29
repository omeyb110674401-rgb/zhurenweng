import type { CoverageVerdict } from './explanation-coverage.ts';

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
 * （模型写出且逐字对得回原文），以及差额的**两种可能**（模型没写 / 本站没读到）—— 不替它们
 * 认领原因。（要说得更准，得让读者侧拿得到 `FeedReport` 的"喂进去几份、几份被截"，
 * 那是另一条链上的事，已登记。）
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
 * 各类改动在正文里的写法。刻意写成"官方会怎么写"，不是"我们想找什么"：
 * 「修改为 / 修改如下 / 删去 / 增加一条 / 作为第X条」都是公文的固定说法。
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

/** 一处在正文里数到的改动表述（位置由 `findChangeMarkers` 给，供探针与"按处列表"用）。 */
export interface ChangeMarker {
  kind: Exclude<ChangeKind, 'other'>;
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
 * 模型没写，也可能是我们没读到（详见文件头 2026-09-28 那条实测）。
 */
export function changeCoverageVerdict(listed: number, markers: ChangeMarkerCount): CoverageVerdict {
  if (markers.total === 0) {
    return { state: 'no_markers', detail: '附件正文里没有数到成文的修改表述，这一栏给不出「共几处」' };
  }
  if (listed >= markers.total) {
    return { state: 'complete', detail: `已列出正文里检测到的全部 ${markers.total} 处修改表述` };
  }
  return {
    state: 'partial',
    detail:
      `正文里检测到 ${markers.total} 处修改表述，本页列出 ${listed} 处 —— ` +
      '检测按本站读到的全部附件正文数；表里只列模型写出、且引用能逐字对回原文的那些，' +
      '差额既可能来自模型没写，也可能来自本站没读到的那部分',
  };
}
