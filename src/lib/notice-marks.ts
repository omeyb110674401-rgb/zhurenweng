import type { NoticeAudience } from './audience.ts';
import { impactsToRender } from './impact-display.ts';
import type { ImpactReviewRecord } from './impact-review.ts';
import type { QuotedSummary } from './summary-content.ts';

/**
 * 列表页的「这条里有什么」标记（issue #87，用户 2026-10-03 拍板）。
 *
 * ## 它解决的是什么
 *
 * 判读（「可能的争议点」）是全站唯一一段回答"这事跟我有没有关系"的内容，而它此前
 * **只存在于详情页里渲不渲染**：列表页没有任何"这条有没有"的可见信号，读者必须先点进去
 * 才知道值不值得读。全库 97 条摘要里只有 11 条带判读 —— 这 11 条正需要被看见。
 *
 * ## 为什么判据必须在这里，而不是写在组件里
 *
 * 与本仓既有规矩一字不差（`summary-display.ts` / `impact-display.ts` / `change-table.ts`
 * 的文件头都写了同一条）：**页面 `.tsx` 里的分支进不了自证框架**。
 * `scripts/check-test-pins.mjs` 的硬规则第 1 条写着"被撤的实现必须从源码被执行"，
 * 而 e2e 跑的是 `.next` 构建产物 —— 撤 `src/app/**` 撤不出红。所以判据留在 `.ts`
 * （单测直读、能进 pin 表），**怎么画**才留给组件。
 *
 * ## 硬约束：必须与详情页同一道门（这一条不是建议，是这一刀的全部风险所在）
 *
 * 「有判读」的判据**只能**经由 `impactsToRender` 判定（issue #47 起它是**选择器**，
 * 此前那个谓词叫 `shouldRenderImpacts`），**不许**在这里重写"受众面 + 非空"或
 * "有没有有效审读记录"这些表达式。
 * 后果是具体的、不是理论的：生产库里有一批 `sector` 条目**存着判读但详情页一个字都不渲染**
 * （受众面门控，用户 2026-09-27 拍板"先只上公众广域"）。列表页若照库里的数组打标记，
 * 读者点进去会发现**什么都没有** —— 列表页在承诺详情页不存在的东西，那比没有标记坏得多。
 * 审读层（issue #47）把这条硬约束又往前推了一步：某条判读被审读**剔除**时，详情页不再渲染它，
 * 列表也就不许靠"库里还存着"来打标 —— 标记与详情页必须**逐格一致**。
 *
 * 同一句话的另外两面：
 * - **未判定（`null` / `unknown`）不打标**：`impactsToRender` 的过渡回落已经这么判，
 *   跟它走即可（"判不出来就不给它加码"）。
 * - **只能说"有"，不能说"无"**：行业专业档、还没生成摘要的、复核没过的，一律**不打任何标记**。
 *   写一个灰色的「暂无判读」会变成一句关于内容质量的评语，而且会把门控暴露成
 *   "这条被判成行业专业了" —— 那是内部口径，不是读者要的信息。
 *
 * ## 为什么不做物化列
 *
 * 列表查询（`listNoticesFiltered`）本来就是 `select()` 全列，`toNoticeRecord` 末尾已经在
 * `JSON.parse(ai_summary_json)` 了 —— 也就是说**列表页今天已经在为判读付出解析代价，
 * 只是把结果丢了**。这一刀的增量只是对 ≤50 个已解析对象跑一次纯函数。
 * 加物化列要付：手写双方言迁移 + 两个 journal 的 `when` 单调 + 回填 + 第二个写入点
 * （人工复核那条路也要维护它）+ 一个会随判读定义漂移的第二真相。而本刀**不加筛选**，
 * 没有一处 SQL 用到它 —— 花一次迁移买一个没人查的列是纯负债。
 * 判读的定义这两周改过四次（#76 建立 → #85 删除 → #86 重建 → 段落判据改口），
 * 每次改口物化列都要一次回填，漏一次就是"列表说含判读、详情页一个字没有"。
 * 真要做 `?has=impacts` 筛选时再加列，比现在加一个会过期的列便宜。
 */

/** 列表项上可能出现的那两种标记。 */
export type NoticeMarkKind = 'impacts' | 'changes';

/**
 * 这条公示该带哪些标记。空数组 = 不打任何标记（**不是**"没有判读"的意思）。
 *
 * 入参收**已经解析过**的 `QuotedSummary | null`，由调用方（`NoticeItem`）解析一次复用 ——
 * 不在这里再解析一遍，否则同一份 JSON 在一次渲染里会被解析两次。
 */
export function noticeMarks(input: {
  audience: NoticeAudience | null;
  summary: QuotedSummary | null;
  /**
   * 审读记录（`notices.impact_review_json`，读侧已过 `parseImpactReviews`）。
   * 与详情页**同一份输入**：缺了它，列表会按"库里存着判读"打标，
   * 而详情页可能已经把那条剔除了 —— 那正是这一刀要避免的事。
   */
  reviews?: readonly ImpactReviewRecord[] | null;
}): NoticeMarkKind[] {
  const { audience, summary, reviews } = input;
  // 没有摘要（或旧形状解析失败）⇒ 不打标。`toNoticeRecordWithoutContent`（邮件那条路径）
  // 给的就是 aiSummary: null，标记自然为"无" —— 那是对的。
  if (summary === null) return [];

  const marks: NoticeMarkKind[] = [];

  // 判读：**调用**详情页那道门，不抄它的表达式（见文件头"硬约束"）。
  const impacts = summary.impacts;
  if (impactsToRender({ audience, impacts, reviews }) !== null) {
    marks.push('impacts');
  }

  // 改动对照：与详情页那一处的提前返回**逐字对齐**（`summary-view.tsx` 里
  // `if (changes.length === 0 && table === null) return null;`）。
  // 两半都要看，因为 `changeTable` 是 worker 在 `changes` 定下之后**补写**的：
  // 历史行可能是"有 changes、没有 changeTable"，反之亦然。
  const changes = summary.changes;
  const table = summary.changeTable;
  const hasChanges = changes.length > 0 || table !== null;
  if (hasChanges) {
    marks.push('changes');
  }

  return marks;
}

/**
 * 标记的文案（改措辞只动这张表，判据一个字不用碰）。
 *
 * 为什么是「含本站推断（非官方）」而不是更像的那个「含 AI 判读（推断）」：
 * ① 对读者来说「AI」不是一个可核对的声明 —— 本站在**卡片头部**已经履行了"AI 生成必须
 *    显著标注"，把「AI」撒到每个列表项上，等于用一个读不出信息量的词占掉这行字最贵的位置，
 *    而**归属**（本站）与非官方性反而丢了；
 * ② 「判读」是内部词（源码注释里用「影响判读」），读者在详情页看到的是标题「可能的争议点」——
 *    列表用一个详情页上不存在的词，点进去会找不到对应物。
 *
 * 也**不是**「含可能的争议点」：那会把详情页那个谨慎的标题（「可能」二字撑着）剥成断言，
 * 列表页没有上下文解释"可能"是谁说的，读起来最接近"这条有争议"。
 *
 * 「含改动对照」不需要"推断"那层限定 —— 改动表是**事实**（每行都挂着逐字原文与可核对的说明）。
 */
export const NOTICE_MARK_LABELS: Record<NoticeMarkKind, string> = {
  impacts: '含本站推断（非官方）',
  changes: '含改动对照',
};

/**
 * 悬停 / 读屏用的完整说明。判读那条与详情页的**块级免责声明同义**
 * （「本站 AI 依据公开原文作出的推断，不是官方表述，也不构成法律意见」）——
 * 列表标记是**提示词**、不是免责声明，它只说"点进去有一段本站的推断"，
 * 免责这项义务仍由详情页那段履行（不许因为列表有了标记就把那段删掉）。
 */
export const NOTICE_MARK_HINTS: Record<NoticeMarkKind, string> = {
  impacts: '本站 AI 依据公开原文作出的推断，不是官方表述，也不构成法律意见',
  changes: '本站从原文逐字摘录的条款改动对照，每行都附可核对的原文',
};
