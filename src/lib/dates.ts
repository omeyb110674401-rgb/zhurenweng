/**
 * 日期工具 —— 公示条目的截止日期只精确到「日」（官方页面以日期展示，不含时刻），
 * 倒计时、状态推导、按日点击统计都按**站点日历日**计算。
 *
 * 站点日历日 = **东八区（Asia/Shanghai）的日历日**，不是进程所在时区的日历日。
 * 这些公示全部来自中国国家级机关，「2026年9月21日前反馈意见」指的是北京时间
 * 9 月 21 日 24:00 —— 日历口径是**数据的性质**，不是部署环境的属性。
 *
 * 为什么必须显式指定时区：生产容器默认跑在 UTC（compose 未设 TZ，实测
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` 为 `UTC`），而开发机在东八区。
 * 按进程时区取「今天」，北京时间 00:00–08:00 这 8 小时里服务器认为还是昨天：
 * 今天截止的条目显示「剩 1 天」、刚过期的条目仍算「征求意见中」、出站点击记到
 * 前一天（北极星指标的日归属错一整天）。更隐蔽的是**测试跑在开发机（东八区）、
 * 生产跑在 UTC** —— 本地全绿，线上错一天。
 *
 * 因此这里用 IANA 时区显式换算，不依赖部署是否设了 `TZ`（也不靠镜像里的 tzdata：
 * 容器内实测 Intl 可正确换算 Asia/Shanghai）。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 站点日历日的时区（中国国家级公示的截止日期都是北京时间概念） */
export const SITE_TIME_ZONE = 'Asia/Shanghai';

const SITE_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: SITE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * 站点日历日（东八区）的 ISO 日期（YYYY-MM-DD）。
 *
 * 用 formatToParts 逐段取值而不是依赖某个 locale 的拼接格式（`en-CA` 之类），
 * 免得换个 ICU 版本格式就变；取不到分段时直接抛错 —— 这里宁可不返回，
 * 也不能悄悄退回进程时区给出错一天的日期。
 */
export function siteDateIso(date: Date): string {
  const parts = SITE_DATE_FORMAT.formatToParts(date);
  const value = (type: 'year' | 'month' | 'day'): string => {
    const part = parts.find((item) => item.type === type);
    if (part === undefined) {
      throw new Error(`Intl 未返回 ${type} 分段（时区 ${SITE_TIME_ZONE}）`);
    }
    return part.value;
  };
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** 站点日历日的月份（YYYY-MM）：统计页的趋势窗口按它取当前月。 */
export function siteMonthIso(date: Date): string {
  return siteDateIso(date).slice(0, 7);
}

/**
 * 最近 count 个站点日历月（含当前月），升序返回 YYYY-MM —— 统计页趋势窗口。
 *
 * 放在这里而不是页面里：页面与 e2e 测试各写过一份「最近 N 个月」的实现，
 * 两份都按进程时区取当前月，于是容器跑 UTC 时页面窗口左移一个月、而测试
 * （跑在开发机东八区）照样通过。口径只能有一份。
 */
export function lastSiteMonths(now: Date, count: number): string[] {
  const [year, month] = siteMonthIso(now).split('-').map(Number) as [number, number];
  const months: string[] = [];
  for (let i = 0; i < count; i += 1) {
    // 用「距 1970-01 的月份序号」倒推，避免拿 Date 做月份加减（跨年与时区都会被卷进来）
    const index = year * 12 + (month - 1) - i;
    months.push(`${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`);
  }
  return months.reverse();
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
 * 距离截止日期还剩的日历天数（按站点日历日，东八区）：
 * 今天截止为 0，明天截止为 1；已过为负数；无法解析为 null。
 */
export function daysUntil(deadlineIso: string | null | undefined, now: Date): number | null {
  const deadline = normalizeDateText(deadlineIso);
  if (!deadline) return null;
  const [y, m, d] = deadline.split('-').map(Number) as [number, number, number];
  const deadlineUtc = Date.UTC(y, m - 1, d);
  const [ny, nm, nd] = siteDateIso(now).split('-').map(Number) as [number, number, number];
  const todayUtc = Date.UTC(ny, nm - 1, nd);
  return Math.round((deadlineUtc - todayUtc) / DAY_MS);
}
