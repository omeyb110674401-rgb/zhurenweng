/**
 * 日期工具 —— 公示条目的截止日期只精确到「日」（官方页面以日期展示，
 * 不含时刻），倒计时与状态推导都按本地日历日计算，保证与时区无关。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 取本地日历日的 ISO 日期（YYYY-MM-DD）。 */
export function localDateIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 从 ISO / 斜杠 / 点分 / 中文日期字符串中提取 YYYY-MM-DD；无法解析返回 null。
 *
 * 四种写法都要认：政府站点同一栏目里混用「2026-09-07」「2026/09/07」
 * 「2026.09.07」「2026年9月7日」是常态。曾只认 ISO 与中文（斜杠只在
 * extract.ts 的正则里被「认了却转不出来」），斜杠写法的截止日期与发布日期
 * 会静默丢失 —— 截止日期丢了会连带影响倒计时、列表排序与截止提醒。
 */
export function normalizeDateText(text: string | null | undefined): string | null {
  if (!text) return null;
  const numeric = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
  if (numeric) return toIso(Number(numeric[1]), Number(numeric[2]), Number(numeric[3]));
  const cn = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(text);
  if (cn) return toIso(Number(cn[1]), Number(cn[2]), Number(cn[3]));
  return null;
}

function toIso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * 距离截止日期还剩的日历天数（按本地日历日）：
 * 今天截止为 0，明天截止为 1；已过为负数；无法解析为 null。
 */
export function daysUntil(deadlineIso: string | null | undefined, now: Date): number | null {
  const deadline = normalizeDateText(deadlineIso);
  if (!deadline) return null;
  const [y, m, d] = deadline.split('-').map(Number) as [number, number, number];
  const deadlineUtc = Date.UTC(y, m - 1, d);
  const [ny, nm, nd] = localDateIso(now).split('-').map(Number) as [number, number, number];
  const todayUtc = Date.UTC(ny, nm - 1, nd);
  return Math.round((deadlineUtc - todayUtc) / DAY_MS);
}
