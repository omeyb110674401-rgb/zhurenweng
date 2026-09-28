/**
 * 摘要**喂入侧**的分档与预算（issue #86 第 3 刀）。
 *
 * 为什么要有这个文件：在这之前，"喂多少"这件事散在三处 —— 仓库层按字数排前 3、
 * worker 按 `PROMPT_CHARS_PER_ATTACHMENT`/`TARGET_TOTAL_CJK_CHARS` 截取、适配器再用
 * `MAX_DRAFT_TOTAL_CHARS`/`MAX_EXPLANATION_TOTAL_CHARS` 兜一次底。三处**各自都能静默丢内容**，
 * 而丢掉的那一截从来不落库（#79 那条"模型返回空数组 vs 引用被反查丢掉"分不出来，就是同一类洞）。
 *
 * 这一刀做两件事，依据是**实测**（`deploy/audit-feed-window.sql` 看附件有多大；
 * `scripts/audit-draft-window.mjs` 看今天真的喂进去了哪一截），不是推理：
 *
 * ① **分档**：受众面 = 公众广域的条目走重档（`deep`），其余走标准档（`standard`，数字与这一刀
 *    之前逐个相同）。依据是用户的取舍「对公众广域那一档做更细的分析」（#83 第七节、#86 第六节）。
 *
 * ② **保底份额**（`minShare`）：一份附件不该被前面的巨无霸挤成几百字的残片。
 *    **但实测要如实说**：今天库里没有一条走得到这一支 —— 未截止的公众广域只有 3 条，
 *    唯一有三份可读附件的 `41f2e22edef76d7e` 实测是 `7973 + 7973 + 6249` 字符 / 合计 7,913 汉字，
 *    离 12,000 的预算还远（那批环保标准的汉字密度只有 0.35，大量化学名与拉丁字母不占汉字额度）。
 *    它挡的是形状上**可能出现**的那一类：三份纯中文草案，两份 8,000 字的窗口就能吃掉 12,000 的
 *    汉字预算，第三份只剩几十字 —— 而那正是用户最关心的"法律修正草案"的形状。
 *    ⇒ 这一支是**结构保险，不是今天的数据**；`FeedReport.starved` 是它的绊线。
 *
 * 三条刻意的设计：
 * - **单位是"汉字"给总预算、"字符"给单份上限**，与既有的 `TARGET_TOTAL_CJK_CHARS` /
 *   `PROMPT_CHARS_PER_ATTACHMENT` 一致。`countCjk(text) <= text.length` 恒成立，所以按字符
 *   记账永远是**保守**的一方（配额不会被花超）。
 * - **`summaryTierFor` 只认 `'public'`**：判不出来（null / 空 / 白名单外的值）一律回标准档。
 *   反过来写（"不是行业专业就上重档"）会让分类器的每一个未知值都变成一次加倍的调用成本。
 * - **"全都装得下"要单独判一次**（`feedFitsAll`）：装得下就一份都不截。没有这一支，
 *   保底会替后面那些"本来就吃得下"的附件扣住额度 —— 实测那条就会白丢 226 字符的条文。
 */

import {
  PROMPT_CHARS_PER_ATTACHMENT,
  TARGET_TOTAL_CJK_CHARS,
  countArticleAnchors,
  type AttachmentRole,
} from './attachment-select.ts';

export type SummaryTier = 'standard' | 'deep';

export interface FeedBudget {
  /** 单份进提示词的字符上限（`excerptForPrompt` 的单位，与 #57 的预算同源） */
  perSource: number;
  /** 全部来源合计的汉字上限（超出即不再喂后面的） */
  total: number;
  /** 每一份的保底份额（汉字）：前面的来源不许把这一份挤到 minShare 以下 */
  minShare: number;
  /** 「附件条文」段落的最后一道防线（字符，适配器用） */
  draftBlockChars: number;
  /** 「编制说明」段落的最后一道防线（字符，适配器用） */
  explanationBlockChars: number;
}

/**
 * 两档的预算。**标准档就是这一刀之前的数字**，一个字都没动 —— 行业专业那一档的行为必须
 * 逐条不变，否则这一刀就不是"分级投入"而是"全体改版"。
 *
 * 那两个数字**直接引用老的常量**（`PROMPT_CHARS_PER_ATTACHMENT` / `TARGET_TOTAL_CJK_CHARS`），
 * 不在这里再抄一遍：#83 刚清完七个"文档说能调、实际没人读"的幽灵旋钮，
 * 同一个数字存在两份就是下一次漂移的入口。
 *
 * 说明段落那两条上限的由来（旧注释里的实测）：编制说明**中位 19,207 字**，而条文动辄上万，
 * 两段共用一条预算时先被喂满的一定是排在前面的条文，说明永远只剩个开头 —— 那还不如不给它段落。
 */
export const SUMMARY_TIERS: Record<SummaryTier, FeedBudget> = {
  standard: {
    perSource: PROMPT_CHARS_PER_ATTACHMENT,
    total: TARGET_TOTAL_CJK_CHARS,
    minShare: 1_500,
    draftBlockChars: 24_000,
    // 10,000 是继承来的数字（#76 就在），它比 `perSource` 大但**比两份窗口之和小**：
    // 一份说明永远装得下，两份各 8,000 字符的说明会被切掉尾部。这是标准档（行业专业）
    // 既有的紧，本刀按"那一档行为逐条不变"的取舍不动它 —— 已登记在 FOLLOWUPS 里等实测。
    explanationBlockChars: 10_000,
  },
  deep: {
    // 2 倍。实测依据只有一处、要如实说：`41f2e22edef76d7e` 那份 35,980 字的批量编制说明
    // 现在被单份上限切到 7,973 字符（2,753 汉字），扩到 16,000 才让它进得去一半以上；
    // 同一批里那两份条文（7,973 / 6,249 字符）**本来就整份进得去**，扩窗对它们没有增益。
    // 所以这一档买的不是"救回被挤掉的条文"，而是"大头文件读得更多"。
    perSource: 16_000,
    total: 24_000,
    // 保底 4,000：走到"装不下"那一支时，一份纯中文草案的窗口不会小于这个量级。
    minShare: 4_000,
    // 上限给到"两份都塞满"的余量：这一层只是**最后一道防线**（挡"把整份文档直接塞进来"
    // 的调用方），不是预算本身。压到 20,000 会把第二份说明的尾部静默切掉 —— 那正是这一刀要消灭的
    // 失败模式，所以这里宁可松。两份 × 16,000 = 32,000。
    draftBlockChars: 48_000,
    explanationBlockChars: 32_000,
  },
};

/**
 * 受众面 → 档位。只有 `'public'`（公众广域）走重档。
 *
 * 「未判定」与任何白名单外的值都回标准档：受众面分类器的未知值不该变成一次加倍的调用成本，
 * 而"重档"是有代价的（调用更慢、吃更多 token、欠着境外通道的合规债）。
 */
export function summaryTierFor(audience: string | null | undefined): SummaryTier {
  return audience === 'public' ? 'deep' : 'standard';
}

/**
 * 这一批附件**全都装得下吗**：把每一份按单份上限各切一刀，这些窗口的汉字数加起来超没超总预算。
 *
 * 为什么必须传"切过之后"的汉字数、不能传原文的：**汉字密度差别极大**。实测那批环保标准的
 * 编制说明 35,980 字里只有约 12,400 个汉字（大量化学名与拉丁字母），8,000 字符的窗口里只装到
 * 2,753 个汉字；而一份纯中文的部门规章密度是 0.9 上下。按原文汉字数判"装不下"就会在一个
 * 明明装得下的条目上白切一刀（实测那条正是这样），所以判据只能落在**真正要送进去的那一截**上。
 *
 * 只有一行算术，单独成函数的理由是那条判据本身：**装得下就一份都不截**。
 * 少了它，保底会替"本来就吃得下"的后面那些扣住额度。
 */
export function feedFitsAll(windowCjk: number[], total: number): boolean {
  return windowCjk.reduce((sum, cjk) => sum + cjk, 0) <= total;
}

/**
 * 装不下时，这一份能拿到的字符配额（纯函数，逐份调用）。
 *
 * @param rest   还**没轮到**的那些附件的汉字数（按喂入顺序，不含当前这一份）
 * @param used   已经花掉的汉字数（调用方按"实际送进去的那一截"累计 ⇒ 永远不超过预算）
 *
 * 这一支只在"三份以上、且前面已经吃掉 2,500 汉字以上"时才会与旧公式（`total - used`）不同：
 * `n ≤ 2` 时 `total - 保底 > 单份上限`，保底根本咬不到（有单测钉这一条）。
 * 保底只替**后面那些真的用得完的**留：一份 300 字的附件不该占住 1,500 的额度 ——
 * 留出来花不掉的额度是净损失。
 */
export function feedAllowance(
  rest: number[],
  state: { used: number; budget: Pick<FeedBudget, 'perSource' | 'total' | 'minShare'> },
): number {
  const reserve = rest.reduce((sum, cjk) => sum + Math.min(state.budget.minShare, cjk), 0);
  const left = state.budget.total - state.used - reserve;
  return Math.max(0, Math.min(state.budget.perSource, left));
}

/** 喂入清单里的一条（写进诊断，回答"这一份到底喂了多少、是不是被切了"）。 */
export interface FeedSourceReport {
  name: string;
  role: AttachmentRole;
  /**
   * 这一份是从哪来的（issue #86 第十六节）：官方**附件**，还是**公告正文本身**。
   * 后者只有在附件侧一份条文都没有、而正文自带条文形状时才会出现（见 `bodyLooksLikeDraft`）。
   */
  origin: 'attachment' | 'body';
  /**
   * 这份附件**本身**的汉字数（截取前）。
   *
   * 与 `fedCjk` 分两个字段而不是共用一个 `cjk`：两个数的基不同，混在一个键里读的人
   * 分不清"这份附件有多大"与"它实际贡献了多少额度" —— 而这一刀要回答的恰恰是后者。
   */
  fullCjk: number;
  /** 实际送进提示词的那一截的汉字数（预算按它记账） */
  fedCjk: number;
  /** 实际送进提示词的字符数 */
  chars: number;
  /** 拿到的字符配额 */
  allowance: number;
  /** 送进去的比原文短（被窗口截过） */
  truncated: boolean;
}

/** 一次喂入的完整交代（落进 `summary_diagnostics_json`，见 summary-diagnostics.ts）。 */
export interface FeedReport {
  tier: SummaryTier;
  budget: Pick<FeedBudget, 'perSource' | 'total' | 'minShare'>;
  /** 实际花掉的汉字数 */
  usedCjk: number;
  sources: FeedSourceReport[];
  /**
   * 抽出来了、却一个字都没送进去的那些。**这一项是这个文件存在的理由**：
   * 它们此前不留任何痕迹，"模型没读到"与"我们没喂"在库里长得一模一样。
   */
  starved: { name: string; fullCjk: number }[];
}

export function emptyFeedReport(tier: SummaryTier): FeedReport {
  const budget = SUMMARY_TIERS[tier];
  return {
    tier,
    budget: { perSource: budget.perSource, total: budget.total, minShare: budget.minShare },
    usedCjk: 0,
    sources: [],
    starved: [],
  };
}

/**
 * 「正文本身就是条文」时，那份来源在提示词与页面上的名字（issue #86 第十六节）。
 *
 * 用常量而不是各处手写字符串：读侧要靠它把「出处：附件《…》」改成「出处：本页正文」，
 * 两处写法一旦漂移，页面上就会出现一条指向"附件《本页正文》"的假出处。
 */
export const BODY_DRAFT_LABEL = '本页正文（公告里直接给出的条文）';

/** 判"正文本身就是条文"的两个门槛，都由实测定的（见下）。 */
export const BODY_DRAFT_MIN_CHARS = 1_500;
export const BODY_DRAFT_MIN_ANCHORS = 5;

/**
 * 这份公示的**正文**是不是就是条文本身（纯函数）。
 *
 * 为什么要有它：`cac`（国家互联网信息办公室）把草案全文直接发在页面正文里、**从不发附件**。
 * 实测（2026-09-27 只读，`deploy/audit-inline-drafts.sql`）：全库正文 ≥1,500 字符的条目**恰好 7 条、
 * 全是 cac、其中 0 条有可读附件**，而其中 6 条的正文带条文形状 ——
 * 《互联网信息服务管理办法（修订草案）》181 处「第X条」、《反网络暴力法（征求意见稿）》78 处、
 * 《未成年人网络保护规定》40 处…… 在这之前它们**一条都产不出条文要点/判读**：
 * 提示词明令"没有「附件条文」段落时 keyPoints 必须为空数组"，而反查池也只有附件。
 *
 * 两个门槛都来自那批实测，不是拍的：最小的真草案正文 3,550 字符 / 22 处锚点，
 * 而公告壳（npc 那 5 条法律草案）是 220–234 字符、0 处锚点；全库最大的壳 532 字符。
 * ⇒ 取 1,500 字符 + 5 处锚点，两侧都留了足够余量，且**壳不可能通过**（它没有条号）。
 */
export function bodyLooksLikeDraft(bodyText: string | null | undefined): boolean {
  const text = bodyText ?? '';
  return text.length >= BODY_DRAFT_MIN_CHARS && countArticleAnchors(text) >= BODY_DRAFT_MIN_ANCHORS;
}
