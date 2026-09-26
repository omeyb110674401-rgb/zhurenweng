import { draftAvailability, type DraftAvailabilityInput } from './summary-display.ts';

/**
 * 摘要的「依据」与「优化状态」（issue #83）：这份 AI 摘要到底是**读了附件条文**写出来的，
 * 还是只依据公示页信息？以及它还值不值得重跑一次？
 *
 * 站长的原始诉求（2026-09-26）："AI 摘要残留大量之前的非附件仅公示信息，最好全量取消
 * 或分类为已优化的和未优化的"。**选了分类，没有全量取消**，理由记在生产实测上：
 *
 * - 全库 192 条里 84 条有摘要（其余 108 条已截止，按设计不生成）；
 * - 其中 **28 条压根没有随文附件**（公告本身就是它全部的信息源），2 条附件源站拒绝 / 扫描件
 *   —— 这 30 条**重跑也只会得到同样的结果**，全量取消等于白花 30 次境外调用；
 * - 真正能靠重跑改善的是另一批：有附件依据但生成于旧模板的 41 条（见下面的 `template` 轴）。
 *
 * 三条正交的事实，别混成一条：
 * 1. **依据**（`basis`）：摘要的输入是什么 —— 附件条文 / 附件读到了但没喂 / 只有公示页 …；
 * 2. **模板**（`template`）：生成它的那版提示词（`current` = 有编制说明要点那一版）；
 * 3. **可优化性**（`state`）：拿上面两条推出的运营结论 —— 还值得重跑，还是重跑也没用。
 *
 * 为什么不落库成列：这三样都能从既有事实（`notice_attachments` 的状态与 `fed_to_summary`、
 * `ai_summary_json` 的键与内容）当场算出来，而**能算出来的东西存下来就会过期**
 * （#30 的教训：多一个需要维护的字段，就多一处会与真相脱节的地方）。所以它是一层纯函数，
 * 页面、后台与审计脚本共用同一份判定。
 */

/**
 * 摘要的内容依据（判据全部来自仓库里已有的事实，不看 `ATTACHMENT_TEXT` 档位 ——
 * 档位是运维配置，读者既不关心也看不懂，见 summary-display.ts 的同一段说明）。
 */
export type SummaryBasis =
  /** 附件条文要点已产出：摘要里有能反查到附件的条文 / 说明 / 改动点 */
  | 'attachment-points'
  /** 附件读到了、也喂给了模型，但这条公告没有可逐条概括的条文（名单 / 打包清单类） */
  | 'attachment-no-points'
  /** 附件能读，但这份摘要生成时没用上它们（未优化） */
  | 'attachment-unused'
  /** 有附件但读不到（源站拒绝 / 扫描件 / 不支持的格式） */
  | 'attachment-unreadable'
  /** 公告没有随文附件：摘要只能依据公示页信息 */
  | 'notice-only'
  /** 还没探测过附件（抽取任务没跑到它）—— 不能替源站宣布"没有附件" */
  | 'not-probed';

export const SUMMARY_BASIS_LABELS: Record<SummaryBasis, string> = {
  'attachment-points': '附件条文',
  'attachment-no-points': '附件已读、无可摘条文',
  'attachment-unused': '读了附件但摘要未用',
  'attachment-unreadable': '附件读不到',
  'notice-only': '仅公示页信息',
  'not-probed': '未探测附件',
};

/** 运营口径的说明（审计脚本与后台用）：一句话说清这个依据意味着什么。 */
export const SUMMARY_BASIS_NOTES: Record<SummaryBasis, string> = {
  'attachment-points': '摘要里有逐条反查到附件的要点，这条是"读过条文"的',
  'attachment-no-points': '附件读了也喂了，但公告是名单 / 打包清单类，本来就没有可逐条摘的条文',
  'attachment-unused': '附件能读却没喂给这份摘要 —— 重跑一次就能改善',
  'attachment-unreadable': '源站拒绝访问或格式不支持，重跑也读不到',
  'notice-only': '公告没有随文附件，公示页就是它全部的信息源 —— 重跑结果不会变',
  'not-probed': '抽取任务还没跑到它，之后会自动补上',
};

/**
 * 生成这份摘要的模板版本。
 *
 * 判据是 **`explanationPoints` 这个键在不在**：issue #76 之后的代码才会写它
 * （见 summary-content.ts 的 `buildQuotedSummary`，新代码每次都写全部键）。
 * 用"键在不在"而不是"值是不是空"：值可以是空数组（这条没有说明要点），
 * 而键缺席只可能来自旧代码 —— 这与 #78 那次误报同源（键在不在 vs 值是多少）。
 */
export type SummaryTemplate = 'current' | 'legacy';

export function summaryTemplateOf(rawSummary: unknown): SummaryTemplate {
  if (typeof rawSummary !== 'object' || rawSummary === null) return 'legacy';
  return 'explanationPoints' in (rawSummary as Record<string, unknown>) ? 'current' : 'legacy';
}

/** 运营结论：这份摘要还有没有重跑的价值。 */
export type SummaryUpgradeState =
  /** 已优化：读了附件条文，且用的当前模板 */
  | 'optimized'
  /** 未优化但可优化：重跑一次就有机会变好（读到了没喂 / 旧模板） */
  | 'upgradable'
  /** 无法优化：没有可读的附件，或者这条本来就没有条文可摘 —— 重跑是白跑 */
  | 'not-upgradable';

export const SUMMARY_UPGRADE_LABELS: Record<SummaryUpgradeState, string> = {
  optimized: '已优化',
  upgradable: '未优化（可重跑）',
  'not-upgradable': '未优化（重跑无效）',
};

export interface SummaryProvenance {
  basis: SummaryBasis;
  template: SummaryTemplate;
  state: SummaryUpgradeState;
  /** 依据的中文名（页面与脚本共用，避免两处各写一遍） */
  label: string;
  /** 依据意味着什么（一句人话） */
  note: string;
}

/**
 * 由「附件事实 + 摘要内容 + 模板版本」推出完整口径。
 *
 * `hasAttachmentPoints` 由调用方给（摘要里是否有反查到附件的要点）：判定那件事要读
 * 摘要 JSON 的三段数组，而本模块刻意不依赖摘要形状 —— 形状的真相在 summary-content.ts。
 */
export function summaryProvenance(input: {
  /** 附件报告；null = 没探测过 */
  attachment: DraftAvailabilityInput | null;
  /** 摘要里是否有附件条文要点（keyPoints / explanationPoints / changes 任一非空） */
  hasAttachmentPoints: boolean;
  /** 摘要是哪个模板生成的（见 summaryTemplateOf） */
  template: SummaryTemplate;
}): SummaryProvenance {
  const draft = draftAvailability(input.attachment);
  const basis: SummaryBasis =
    draft.kind === 'not-probed'
      ? 'not-probed'
      : draft.kind === 'no-attachments'
        ? 'notice-only'
        : draft.kind === 'unreadable'
          ? 'attachment-unreadable'
          : draft.kind === 'read-not-used'
            ? 'attachment-unused'
            : input.hasAttachmentPoints
              ? 'attachment-points'
              : 'attachment-no-points';

  return {
    basis,
    template: input.template,
    state: upgradeStateOf(basis, input.template),
    label: SUMMARY_BASIS_LABELS[basis],
    note: SUMMARY_BASIS_NOTES[basis],
  };
}

/**
 * 依据 × 模板 → 还能不能靠重跑变好。
 *
 * 为什么旧模板也算"可重跑"：issue #76 之后的提示词多要了「编制说明要点」那一栏，
 * 所以一条**有附件依据**的旧模板摘要重跑后确实会多出一节读者能看的内容。
 * 反过来，"附件读不到 / 没有附件 / 本来就没有条文可摘"三种，重跑一百次也是同一个结果 ——
 * 把它们标成"该重跑"就是把运维的时间花在不会变的事情上，所以两者在文案上必须分开
 * （`未优化（可重跑）` vs `未优化（重跑无效）`）。
 */
function upgradeStateOf(basis: SummaryBasis, template: SummaryTemplate): SummaryUpgradeState {
  if (basis === 'attachment-points') {
    return template === 'current' ? 'optimized' : 'upgradable';
  }
  if (basis === 'attachment-unused') return 'upgradable';
  return 'not-upgradable';
}
