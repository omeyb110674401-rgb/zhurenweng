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

/** 从 ISO / 中文日期字符串中提取 YYYY-MM-DD；无法解析返回 null。 */
export function normalizeDateText(text: string | null | undefined): string | null {
  if (!text) return null;
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));
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
