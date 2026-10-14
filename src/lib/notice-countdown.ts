import type { NoticeRecord } from '../db/types.ts';
import { daysUntil } from './dates.ts';
import { effectiveStatus } from './notice-status.ts';

/**
 * 截止倒计时的展示判据与紧迫度分档（2026-10-07）。
 *
 * ## 为什么单独成文件（而不是留在 `app/_lib/notice-display.tsx` 里）
 *
 * 这里是**判据**，`.tsx` 那边只做摆放 —— 与 `src/lib/notice-status.ts`（`effectiveStatus`）、
 * `src/lib/impact-display.ts`（`shouldRenderImpacts` / `impactOverview`）同一条项目口径：
 * 页面里的分支进不了单测（单测是 `node --test` 直跑 `.ts`/`.mjs`，Node 的类型剥离不吃 `.tsx`，
 * 实测 `ERR_UNKNOWN_FILE_EXTENSION`），所以"哪一档挂哪个类"必须是**可导入、可断言的返回值**，
 * 不能是组件里的一次三元拼接。分档边界（0–1 / 2–3 / ≥4）是有产品含义的阈值，只能靠真值表钉住。
 *
 * ## 两条被这一刀修掉的问题
 *
 * 1. **同一张卡片上两个状态口径**：倒计时此前判 `notice.status !== 'open'`（**库列快照**），
 *    而同一行的状态徽标判 `effectiveStatus()`（展示层复核，issue #43）。状态列是抓取时
 *    推导的，而抓取每日一轮 —— 生产实测每天 00:00 到下一轮之间约 14 小时里，同一张卡片上
 *    徽标已经写「已截止」、倒计时却还在。现在两者共用 `effectiveStatus`，不再有第二份判据。
 * 2. **紧迫度只有一档**：醒目样式此前只在「今天截止 / 明天截止」触发，判据还是**文案字符串**
 *    （`text === '今天截止' || text === '明天截止'`）—— 于是「剩 2 天」「剩 3 天」与「剩 30 天」
 *    长得一模一样，最该催人的那一档反而不醒目；而文案改一个字就会把分档一起改坏。
 *    现在按**天数**分两档，文案一个字都没改（既有 e2e 锚在「剩 N 天」上）。
 */

/**
 * 剩余天数（站点日历日，东八区）。
 *
 * 只在**展示用有效状态**是「征求意见中」时给数：不是就不展示倒计时（与徽标同一条判据）。
 * 天数算不出来（没有截止日期 / 日期是坏值）同样返回 null —— 推不出就什么都不显示，
 * 不编一个数出来。
 */
export function countdownDays(notice: NoticeRecord, now: Date): number | null {
  if (effectiveStatus(notice, now) !== 'open') return null;
  const days = daysUntil(notice.deadlineAt, now);
  return days !== null && days >= 0 ? days : null;
}

/** 截止倒计时文案；非征求意见中或不带截止日期时返回 null（不展示）。文案与改动前逐字一致。 */
export function countdownText(notice: NoticeRecord, now: Date): string | null {
  const days = countdownDays(notice, now);
  if (days === null) return null;
  if (days === 0) return '今天截止';
  if (days === 1) return '明天截止';
  return `剩 ${days} 天`;
}

/**
 * 倒计时该长什么样 —— 文案 + 类名一次给全（组件那一层于是退化成纯模板）。
 *
 * 分档（按剩余天数）：
 *   · 0–1 天 → `countdown countdown-urgent`（最强档，保持原有样式：红底 + 加粗）
 *   · 2–3 天 → `countdown countdown-soon`（中间档：描边转橙、底色褪成中性、不加粗）
 *   · ≥4 天  → `countdown`（只有基础档，与「剩 30 天」同类）
 *   · 不展示 → `null`
 */
export function countdownView(
  notice: NoticeRecord,
  now: Date,
): { text: string; className: string } | null {
  const days = countdownDays(notice, now);
  const text = countdownText(notice, now);
  if (text === null) return null;
  if (days === null) return { text, className: 'countdown' };
  if (days <= 1) return { text, className: 'countdown countdown-urgent' };
  if (days <= 3) return { text, className: 'countdown countdown-soon' };
  return { text, className: 'countdown' };
}
