/**
 * 「编制说明要点」的覆盖度（issue #76 第 3 刀）—— 纯函数。
 *
 * 为什么要有这一层：读者看到一串按小节列出的说明要点，第一个问题应该是
 * **"这是全部吗"**。答案不能来自模型的自我申报，只能来自本站自己在说明原文里数出来的
 * 小节标题数 vs 页面列出的条数。于是页面能给出一句可核对的话："已列出检测到的约 N 个小节"。
 *
 * ⚠️ **2026-09-28：这一句改口了（issue #86 §19.4 那条债的收尾）。** 从前列得少时它说
 * 「其余的不在本站读到的那一截里」——那是**我们不知道的事**，而实测里它是假的：同一份说明
 * 整份都在喂入窗口内（`feed` 里每一份的 `truncated` 都是 false），模型仍然只列出三分之一的小节。
 * 现在两处覆盖度文案（本文件与 `change-coverage.ts`）**共用** `coverageGapAttribution`：
 * - 只有**喂入清单真的报了缺口**（某一份被截 / 某一份一个字都没喂进去）时，才允许把
 *   "差额可能出在没喂进去的那一截上"作为一种可能说出来；
 * - 清单说每一份都整份进了窗口 ⇒ 差额归给模型没写（写出来的若引用对不回原文，也会被丢掉）；
 * - 压根没有喂入记录（v1 的存量行、人工录入）⇒ 照实说"本站给不出可核对的答案"，不猜。
 * 这条链的入口在读者侧：`getNoticeSummary` 取 `summary_diagnostics_json` → 详情页
 * `parseSummaryDiagnostics(...).feed` → `SummaryView` 把清单交给三个判据。
 * **不要只改一处**：两个判据共用 `CoverageVerdict`，说法不一致会让读者以为两栏的可信度不同。
 *
 * **本文件原名 `amendment-coverage.ts`，里面还有一半是「修正案改动点」的计数与覆盖度**
 * （`countChangeMarkers` / `changeCoverageVerdict` / `CHANGE_KIND_LABELS`）。
 * 那一半于 2026-09-27 随整个「改动点」功能删除（issue #85），文件因此改名。
 *
 * **⚠️ 2026-09-27 更正：那次删除的判据是错的，改动点那一半已按实测重建**
 * （现住在 `change-coverage.ts`，issue #86 第 2 刀）。删除依据的"5 条候选点名重跑后仍是
 * 0 条"**没有发生过** —— 那 5 条候选从来没有被带这段代码的版本重跑过，用旧提示词重跑
 * 金丝雀一次就吐出 10 条、8 条通过逐字反查。完整经过见 `86-*.md` 第九节。
 * **但本文件留下是对的**：改名这件事与那一半的存废无关 —— 只留编制说明覆盖度时，
 * 叫 `amendment-coverage` 就是下一轮读代码的人的第一个坑。
 */

import { attachmentRole, type AttachmentRole } from './attachment-select.ts';
import type { FeedReport, FeedSourceReport } from './attachment-feed.ts';

export interface CoverageVerdict {
  state: 'complete' | 'partial' | 'no_markers';
  detail: string;
}

/**
 * 喂入清单里**我们关心的那些来源**（`role` 不给就是全部）。
 *
 * `starved` 那一列只带名字与原件汉字数、不带 role（形状管在 `attachment-feed.ts`，
 * 这一刀不动它），所以按**同一份** `attachmentRole` 从名字重算 —— worker 定 role 用的就是它
 * （`feedPlanForSummary`），不是第二套判据。唯一对不上的是"正文本身就是条文"那一份
 * （worker 那边写死 `draft`，这里会算成 `other`）：它不可能被算成说明类，而两处文案里
 * 只有编制说明那一栏会按 role 过滤，所以这个差别今天不产生任何影响。
 */
function feedView(
  feed: FeedReport,
  role?: AttachmentRole,
): { sources: FeedSourceReport[]; starved: { name: string; fullCjk: number }[] } {
  if (role === undefined) return { sources: feed.sources, starved: feed.starved };
  return {
    sources: feed.sources.filter((item) => item.role === role),
    starved: feed.starved.filter((item) => attachmentRole(item.name) === role),
  };
}

/** 来源类别的说法（只在按 `role` 过滤时用得上：读者要知道这一栏说的是哪一类来源）。 */
const ROLE_NOUNS: Record<AttachmentRole, string> = {
  draft: '条文类',
  explanation: '说明类',
  other: '其他类',
};

/**
 * 本轮喂入清单 → 一句读者能核对的实话（issue #86 §19.4 的收尾）。
 *
 * 它回答的是**这一次调用我们到底给了模型什么**：读到几份来源、几份只喂进一部分（被截）、
 * 几份一个字都没喂进去、一共喂进多少汉字。`null` / `undefined`（v1 的存量行、人工录入）
 * 返回空串 —— 没有清单就一个字都不说，绝不编一份出来。
 *
 * 四条刻意的写法：
 * - **没有一份被截时不许提截断**：那句「没有一份被截」只出现在真的一份都没截、也没饿着的分支里；
 * - 份数与汉字数都从清单自己算（`sources[].fedCjk` 相加，而不是 `feed.usedCjk`）：
 *   按 `role` 过滤之后，整次调用的总数与这一栏说的不是同一批来源；
 * - `role` 是给「编制说明要点」那一栏用的：那一栏的差额只可能出在**说明类**来源上，拿整次调用
 *   的数字去说它，会把"某份条文被截"读成"说明被截" —— 那正是这一刀要消灭的那种假交代；
 * - "被截"只用 `FeedSourceReport.truncated`（原件 vs 实际送进去的那一截），不在读侧重算长度。
 */
export function feedIntakeSentence(
  feed: FeedReport | null | undefined,
  role?: AttachmentRole,
): string {
  if (!feed) return '';
  const { sources, starved } = feedView(feed, role);
  const noun = role === undefined ? '来源' : `${ROLE_NOUNS[role]}来源`;
  const read = sources.length + starved.length;
  if (read === 0) return `本轮没有把任何${noun}喂进模型`;
  if (sources.length === 0) return `本轮读到 ${read} 份${noun}，但一份都没喂进模型`;
  const cut = sources.filter((item) => item.truncated).length;
  const fedCjk = sources.reduce((sum, item) => sum + item.fedCjk, 0);
  const head = `本轮读到 ${read} 份${noun}，共喂进模型 ${fedCjk} 个汉字`;
  if (cut === 0 && starved.length === 0) {
    return `${head}（每一份都整份进了窗口，没有一份被截）`;
  }
  const tails: string[] = [];
  if (cut > 0) tails.push(`其中 ${cut} 份只喂进一部分（被截）`);
  if (starved.length > 0) {
    tails.push(`${cut > 0 ? '另有 ' : '其中 '}${starved.length} 份一个字都没喂进去`);
  }
  return `${head}，${tails.join('，')}`;
}

/**
 * 喂入清单**报过缺口**吗（有来源被截、或有来源一个字都没喂进去）。
 *
 * 这是「差额可能出在没喂进去的那一截上」唯一允许出现的条件（issue #86 §19.4）。清单没报
 * 缺口时再说那句话，就是在替差额认领一个我们不知道的原因 —— 实测里那一次正是假的
 * （说明整份都在窗口内、`truncated: false`，模型仍然只列出三分之一的小节）。
 */
export function feedReportedGap(
  feed: FeedReport | null | undefined,
  role?: AttachmentRole,
): boolean {
  if (!feed) return false;
  const { sources, starved } = feedView(feed, role);
  return starved.length > 0 || sources.some((item) => item.truncated);
}

/**
 * 覆盖度那句交代的后半截：**本轮喂了什么 + 差额能归给谁**（两处覆盖度文案共用）。
 *
 * `subject` 只是那一栏缺的东西的名字（「说明小节」/「改动表述」）—— 两个判据共用
 * `CoverageVerdict`，说法不一致会让读者以为两栏的可信度不同（文件头那条规矩）。
 *
 * 三个分支与 `feedReportedGap` 一一对应，别合并：
 * - 清单报了缺口：把"没喂进去的那一截"作为**一种可能**说出来，不替它认领；
 * - 清单说每一份都整份进了窗口：差额归给模型没写（写出来的若引用对不回原文，也会被丢掉）；
 * - 压根没有清单（v1 的存量行、人工录入）：照实说本站给不出可核对的答案。
 */
export function coverageGapAttribution(
  feed: FeedReport | null | undefined,
  subject: string,
  role?: AttachmentRole,
): string {
  if (!feed) {
    return '这条摘要没有留下本轮的喂入记录，差额出在哪一环本站给不出可核对的答案。';
  }
  const intake = feedIntakeSentence(feed, role);
  if (feedReportedGap(feed, role)) {
    return (
      `${intake} —— 差额可能出在没喂进去的那一截上，` +
      `也可能来自模型没有把检测到的${subject}都写出来。`
    );
  }
  return (
    `${intake} —— 差额来自模型没有把检测到的${subject}都写出来` +
    '（写出来的若引用对不回原文，也会被丢掉）。'
  );
}

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

/**
 * 编制说明的"小节数"就是分母。
 *
 * 这是**启发式**，不是解析器：官方文件的层级写法不统一，数多了或少了都可能。
 * 所以页面那句话要写成"检测到约 N 个小节标题"，不能写成"共 N 节"——
 * 一个假装精确的数字比一个带"约"字的数字更坏。
 *
 * `feed`（可选）是产出这份摘要的那一次调用的喂入清单（`summary_diagnostics_json.feed`，
 * issue #86 §19.4）：不给 / 没有就是"没有喂入记录"，句子照实说说不清，**不猜**差额来自哪一边。
 * 给了就按 `coverageGapAttribution` 说：只有清单真的报了截断，才允许提"没喂进去的那一截"。
 */
export function explanationCoverageVerdict(
  listed: number,
  sections: number,
  feed?: FeedReport | null,
): CoverageVerdict {
  if (sections === 0) {
    return { state: 'no_markers', detail: '未在这份说明里检测到分层小标题' };
  }
  if (listed >= sections) {
    return { state: 'complete', detail: `已列出检测到的约 ${sections} 个小节` };
  }
  return {
    state: 'partial',
    detail:
      `这份说明检测到约 ${sections} 个小节，本页列出 ${listed} 个 —— ` +
      '检测按本站读到的说明正文数，列出的每一节都要求引用能逐字对回原文。' +
      coverageGapAttribution(feed, '说明小节', 'explanation'),
  };
}
