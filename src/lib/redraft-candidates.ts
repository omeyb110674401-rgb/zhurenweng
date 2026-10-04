import { SUMMARY_NOT_SUMMARIZED_STATUS } from './summary-display.ts';
import {
  MANUAL_SUMMARY_MODEL,
  parseQuotedSummary,
  type QuotedSummary,
} from './summary-content.ts';

/**
 * 「这条存量摘要还缺哪一件」的判据（issue #48；决定台账见
 * `docs/pending-issues/91-l3-compliance-review-gate.md` 第八节第 15 条）。
 *
 * ## 它解决的是什么
 *
 * 存量重跑工具（`scripts/reset-summaries-for-redraft.mjs`）原先的幂等过滤只判一件事：
 * "`keyPoints` 里有没有带出处的项"。那条判据写在 issue #67，而**那时的缺口正是条文要点**。
 * 今天缺的是 **L2 / L3**（改动对照 / 判读），这条过滤**判不出这个差别** ——
 * 于是它把最该重跑的那一批（材料已在手、只是当初那次调用没问过 L2/L3）整批跳过。
 * 现场读数见 `87-list-page-discoverability.md` §9.5：97 = 18 已截止 + **38 被它跳过** + 41 池，
 * 而池子里只有 9 条真会被喂进条文。
 *
 * ## 「缺」怎么判：**按"问过没有"，不是按"答出来没有"**
 *
 * 这是本判据的核心，也是它必须住在 `.ts` 里、能被单测直读的原因。
 *
 * - 一份摘要生成于 L2/L3 还没进提示词的那条管线时，它的 JSON 里**连 `impacts` / `changes`
 *   这两个键都没有**。键缺席的含义是确定的：**那次调用根本没问过**（87 号文档 §9.3 的原话是
 *   "是'没问过'不是'没想到'"）。
 * - 反过来，键在、值是空数组，含义是**问过了、模型说没有**（例如一份名单公示本来就没有
 *   改动对照）。它**不缺**，重跑只会白花一次调用。
 *
 * 两者在 `parseQuotedSummary` 之后长得一模一样（都归一成空数组）—— 所以判据只能看**原始
 * JSON**，这就是本函数收"已解析的 `unknown`"而不收 `QuotedSummary` 的理由。
 * （`summary-basis.ts` 的 `summaryTemplateOf` 用的是同一条路数：`explanationPoints` 键在不在
 * 判"是不是旧模板"。同一个技巧、同一类理由 —— 键缺席只可能来自旧代码。）
 *
 * 只按"空数组也算缺"来判会毁掉工具的**幂等**：一份产不出改动对照的条目会被一遍遍清空重跑。
 *
 * ## 为什么还要判旧形状
 *
 * 落库的判读有一个**只有时间能修**的差别（#88 第二刀）：2026-10-02 之前的判读没有 `point`
 * 键（影响点三件之一）。那 6 条行业专业档存量（22 条判读）正是这一类，而它们本轮必须
 * **先重跑、再审读** —— 审读只判合规，判不出"这条判读的生成侧已经过期"（#51 的原话）。
 * 所以 `point` 键缺席也是一条独立的候选理由，与 L2/L3 无关。
 *
 * ## 两条硬红线（不进候选）
 *
 * - **已截止**：摘要队列永远不会再拾起它（入队过滤 `status <> 'closed'`），清了就是永久失去；
 * - **人工复核录入**：那不是模型产出，重跑等于毁掉人的活。
 *
 * 这两条与旧脚本里的红线同源，只是后者此前**没管过人工录入**（它靠"人工摘要没有条文要点 ⇒
 * 进池子"的巧合，反而更容易被清掉）。判据写在这里，是为了让它可被单测与 pin 表钉住。
 *
 * ## 返回值里为什么带一句人话
 *
 * 调用方是 dry-run（只读），它要**逐条**说明"为什么这一条进 / 不进候选"。
 * 只印一个数字的清单读的人没法核对，而"看不见的缺口"正是本项目定义缺陷的方式。
 */

export interface RedraftCandidateInput {
  /** 库内状态列（`notices.status`）：`closed` 是硬红线 */
  status: string;
  /** 摘要模型名（`notices.summary_model`）：`manual` 是硬红线 */
  summaryModel: string | null;
  /**
   * `ai_summary_json` 的**已解析**值（`safeParseJson` 之后，不是字符串）。
   * 收原始形状是因为"键缺席"这个判据在 `parseQuotedSummary` 之后就消失了。
   */
  summary: unknown;
}

export interface RedraftCandidateVerdict {
  candidate: boolean;
  /** 一句人话：为什么进 / 不进候选（dry-run 逐条打印） */
  reason: string;
}

/** `keyPoints` 里有没有**带出处**的一项（#67 的原判据，一个字节没改）。 */
function hasPointsWithSource(summary: QuotedSummary): boolean {
  return summary.keyPoints.some(
    (point) => typeof point.source === 'string' && point.source !== '',
  );
}

/** 原始 JSON 里的判读数组（认不出形状就给空数组）。 */
function rawImpacts(summary: Record<string, unknown>): Record<string, unknown>[] {
  const impacts = summary.impacts;
  if (!Array.isArray(impacts)) return [];
  return impacts.filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
  );
}

/**
 * 这条存量摘要要不要重跑。
 *
 * 顺序即优先级：**硬红线 → 读不出来的产物 → L1 → L2/L3 → 旧形状 → 一件都不缺**。
 * 一条摘要可能同时缺几件，返回的是**第一条**触发的原因（重跑一次会把它们一起补上，
 * 所以报一条就够；报一长串只会让清单更难读）。
 */
export function redraftCandidate(input: RedraftCandidateInput): RedraftCandidateVerdict {
  // ① 已截止：清了就永久失去摘要（摘要队列的入队过滤排除了它们，issue #4 的设计）
  if (input.status === SUMMARY_NOT_SUMMARIZED_STATUS) {
    return {
      candidate: false,
      reason: '已截止（清了就永久失去摘要：摘要队列永远不会再拾起这一条）',
    };
  }
  // ② 人工复核录入：重跑等于毁掉人的活
  if (input.summaryModel === MANUAL_SUMMARY_MODEL) {
    return { candidate: false, reason: '人工复核录入的摘要（重跑等于毁掉人的活）' };
  }

  const raw = input.summary;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      candidate: true,
      reason: '摘要 JSON 认不出形状（页面上就是「待人工复核」占位）⇒ 重跑是恢复它',
    };
  }
  const fields = raw as Record<string, unknown>;

  // ③ 缺条文要点（L1 那一批；#67 的原判据，语义一个字没改）
  const parsed = parseQuotedSummary(raw);
  if (parsed === null) {
    return {
      candidate: true,
      reason: '摘要缺必填段（`parseQuotedSummary` 返回 null，页面上是占位）⇒ 重跑是恢复它',
    };
  }
  if (!hasPointsWithSource(parsed)) {
    return { candidate: true, reason: '缺条文要点（`keyPoints` 里没有带出处的项）' };
  }

  // ④ 没问过 L3 / L2：**键缺席**才说明"那次调用没问"，空数组是"问过、模型说没有"
  if (!('impacts' in fields)) {
    return {
      candidate: true,
      reason: '那次调用没问过 L3（摘要里**没有 `impacts` 这一键**）',
    };
  }
  if (!('changes' in fields)) {
    return {
      candidate: true,
      reason: '那次调用没问过 L2（摘要里**没有 `changes` 这一键**）',
    };
  }

  // ⑤ 判读是旧形状（#88 第二刀之前）：影响点三件里的 `point` 键缺席
  const staleImpact = rawImpacts(fields).some((impact) => typeof impact.point !== 'string');
  if (staleImpact) {
    return {
      candidate: true,
      reason: '判读是旧形状（有判读但缺 `point` 键：生成于「影响点三件」之前）',
    };
  }

  // ⑥ 一件都不缺 ⇒ 跳过（工具因此可以反复跑而不重复花钱）
  return {
    candidate: false,
    reason: '一件都不缺（有带出处的条文要点、问过 L2/L3、判读是新形状）⇒ 跳过',
  };
}
