/**
 * 版本链匹配（issue #10）：把同一法案不同轮次的公示标题规范化为稳定主体键，
 * 供入库时的版本关联逻辑（src/db/repo/versions.ts）判定「是否同一法案」。
 *
 * 匹配规则（PRD user story 10：同一法案不同轮次公示关联为版本链）：
 * 1. 标题规范化 —— 去空白与标点、剥掉书名号内的法案主体、去掉轮次词
 *    （草案 / 审议稿 / 征求意见稿（含「二次征求意见稿」等）/ 修订 / 修正）与
 *    征求意见套语（「关于……的通知」里的通知字样、公开征求意见等）；
 * 2. 同一发布机关 —— 由调用方保证只在同机关条目间匹配（机关不同不链）。
 *
 * 规范化只需要保证「同一法案 → 同一键；不同法案 → 不同键」的一致性，
 * 键本身不用于展示。纯函数、零依赖。
 */

/** 括号内的轮次 / 修订字样：如（草案征求意见稿）（草案二次征求意见稿）（修订草案）（二次审议稿） */
const ROUND_PARENTHETICAL = /[（(][^（）()]*?(?:草案|审议稿|征求意见|修订|修正|初审|一读|二审|三审)[^（）()]*?[）)]/g;

/** 散落的轮次词与征求意见套语（去括号后仍残留的） */
const ROUND_WORDS =
  /(?:征求意见稿|公开征求意见|征求意见|审议稿|修订草案|修正草案|草案|修订|修正|的通知|的公告|的函|的公告丨)/g;

/** 有效主体键的最短长度：过短（纯轮次词标题）不参与匹配，避免误链 */
const MIN_KEY_LENGTH = 4;

/**
 * 标题 → 版本匹配键；规范化后无有效主体（如标题只含轮次词）返回 null。
 *
 * 规范化步骤：去空白 → 取书名号内主体（无书名号则用全文）→ 去含轮次词的
 * 括号段 → 去残留轮次词与套语 → 只保留字母 / 数字 / 汉字 → 小写。
 */
export function normalizeTitleForVersionMatch(title: string): string | null {
  const compact = title.replace(/\s+/g, '');
  if (compact.length === 0) return null;

  // 有书名号时取最长的《…》内文本作为法案主体（如「司法部关于《X法（修订草案）》
  // 公开征求意见的通知」→「X法（修订草案）」）；无书名号用全文
  let text = compact;
  let longestQuoted = '';
  for (const match of compact.matchAll(/《([^《》]*)》/g)) {
    if (match[1].length > longestQuoted.length) longestQuoted = match[1];
  }
  if (longestQuoted.length > 0) text = longestQuoted;

  // 去掉含轮次词的括号段（可能不止一段，循环至稳定）
  let previous = text;
  do {
    previous = text;
    text = text.replace(ROUND_PARENTHETICAL, '');
  } while (text !== previous);

  text = text
    .replace(ROUND_WORDS, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();

  return text.length >= MIN_KEY_LENGTH ? text : null;
}
