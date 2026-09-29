/**
 * 「编制说明要点」的覆盖度（issue #76 第 3 刀）—— 纯函数。
 *
 * 为什么要有这一层：读者看到一串按小节列出的说明要点，第一个问题应该是
 * **"这是全部吗"**。答案不能来自模型的自我申报，只能来自本站自己在说明原文里数出来的
 * 小节标题数 vs 页面列出的条数。于是页面能给出一句可核对的话："已列出检测到的约 N 个小节"，
 * 列得少就照实说"其余的不在本站读到的那一截里"——那也是"要不要为长文上多轮调用"的诚实依据。
 *
 * ⚠️ **2026-09-28：这一句有同一个毛病，尚未改口。** 同构的 `change-coverage.ts` 那一侧已经改成
 * "差额既可能来自模型没写，也可能来自本站没读到"（实测：正文整份都在窗口内时，同一份输入
 * 四遍列出的行数是 8 / 2 / 3 / 8 ⇒ 主因是模型没写，不是我们没读到）。这一侧的原句同样在替
 * 差额认领一个我们不知道的原因。两处一起改的前提是**读者侧拿得到 `FeedReport`**
 * （喂了几份、几份被截），那是一条还没接的链（见 `docs/pending-issues/86-*.md` §19）。
 * 在那之前这里保持原状并留下这条注释 —— **不要只改一处**：两个判据共用 `CoverageVerdict`，
 * 说法不一致会让读者以为两栏的可信度不同。
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

export interface CoverageVerdict {
  state: 'complete' | 'partial' | 'no_markers';
  detail: string;
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
 */
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
