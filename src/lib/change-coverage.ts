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
 * 于是页面能给出一句可核对的话，并让读者知道"其余的不在本站读到的那一截文本里"。
 * 判据与「编制说明要点」那一侧**同构**（所以共用 `CoverageVerdict` 这个形状）。
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

/**
 * 数一遍正文里的改动表述。正则带 g，每次都用新副本，不吃 lastIndex。
 *
 * 同一处文字可能被多个模式各数一次（"删去…增加一条作为第X条"就是一句三处），
 * **这正是要的**：读者关心的是"有多少处表述要解释"，不是"改了几条"。
 */
export function countChangeMarkers(text: string): ChangeMarkerCount {
  const source = text ?? '';
  const byKind = { modify: 0, add: 0, delete: 0, renumber: 0 };
  if (source === '') return { total: 0, byKind };
  for (const [kind, pattern] of Object.entries(KIND_PATTERNS)) {
    const key = kind as keyof typeof byKind;
    byKind[key] = [...source.matchAll(new RegExp(pattern.source, 'g'))].length;
  }
  return { total: byKind.modify + byKind.add + byKind.delete + byKind.renumber, byKind };
}

/**
 * 「改了哪几处」的覆盖率。
 *
 * 分母由调用方按**全部附件正文**数（不是喂进模型的那一截）—— 拿喂进去的那一截数分母，
 * 窗口外的改动永远不会出现在"还差多少"那句话里，那是自证（issue #76 的原始设计）。
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
    detail: `正文里检测到 ${markers.total} 处修改表述，本页列出 ${listed} 处 —— 其余的不在本站读到的那一截文本里`,
  };
}
