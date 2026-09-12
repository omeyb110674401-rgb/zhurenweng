import { and, asc, desc, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '../client.ts';
import { notices, outboundClickDaily } from '../schema/sqlite.ts';

/**
 * 统计页聚合查询（issue #11，M3 数据统计页）。
 *
 * 全部为只读 SQL 聚合，双方言交集子集：
 * - 月份取自 ISO 日期字符串截取 `substr(published_at, 1, 7)`（SQLite / PostgreSQL
 *   均支持 substr，不使用任何方言专属日期函数）；
 * - count / sum 在 PostgreSQL 侧返回 bigint（驱动给 string），统一 Number() 归一；
 * - 公示期长度（截止 - 发布的天数）在应用层按日历日计算 —— 双方言交集内没有
 *   可移植的天数差函数（SQLite julianday / PG date 相减都是方言专属）。
 *
 * 隐私边界（PRD 合规姿态）：全部为纯计数聚合，不涉及任何个人身份
 * （点击数据仅有条目 ID 与日期两个维度）。
 */

/** 各发布机关公示量（agency → 条目数） */
export interface AgencyTotal {
  agency: string;
  count: number;
}

/** 机关 × 月份公示量（month 为 YYYY-MM） */
export interface AgencyMonthCount {
  agency: string;
  month: string;
  count: number;
}

/** 点击 Top 榜条目（链接回详情页） */
export interface TopClickedNotice {
  id: string;
  title: string;
  agency: string;
  outboundClicks: number;
}

/** 按日期聚合的出站点击（date 为 YYYY-MM-DD） */
export interface ClickDateTotal {
  date: string;
  clicks: number;
}

/** 概览数字：收录条目总数与累计出站提意点击（北极星指标总量） */
export interface StatsOverview {
  totalNotices: number;
  totalClicks: number;
}

/** 公示期长度分布桶（天数 = 截止日期 - 发布日期，按日历日） */
export type PeriodBucketKey = 'lte7' | 'b8_15' | 'b16_30' | 'gt30';

/** 分布桶固定顺序（页面按此渲染，统计页文案见 /stats 页面组件） */
export const PERIOD_BUCKET_ORDER: PeriodBucketKey[] = ['lte7', 'b8_15', 'b16_30', 'gt30'];

/**
 * 各发布机关公示量（全量条目，按条目数降序、机关名升序兜底保证稳定排序）。
 */
export async function getAgencyTotals(): Promise<AgencyTotal[]> {
  const db = await getDb();
  const rows = await db
    .select({ agency: notices.agency, count: sql<number>`count(*)` })
    .from(notices)
    .groupBy(notices.agency)
    .orderBy(desc(sql`count(*)`), asc(notices.agency));
  return rows.map((row) => ({ agency: row.agency, count: Number(row.count) }));
}

/**
 * 机关 × 发布月份的公示量（含全部历史月份；「最近 6 个月」窗口由页面侧裁剪，
 * 收录量级为每月数十条，一次取全量分组结果即可）。
 */
export async function getAgencyMonthlyCounts(): Promise<AgencyMonthCount[]> {
  const db = await getDb();
  const monthExpr = sql<string>`substr(${notices.publishedAt}, 1, 7)`;
  const rows = await db
    .select({ agency: notices.agency, month: monthExpr, count: sql<number>`count(*)` })
    .from(notices)
    .where(isNotNull(notices.publishedAt))
    .groupBy(notices.agency, monthExpr);
  return rows.map((row) => ({
    agency: row.agency,
    month: row.month,
    count: Number(row.count),
  }));
}

/**
 * 出站提意点击 Top 榜（点击数 > 0 的条目，按点击数降序、条目 ID 升序兜底）。
 * 页面据此链接回详情页；limit 默认 10。
 */
export async function getTopClickedNotices(limit = 10): Promise<TopClickedNotice[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: notices.id,
      title: notices.title,
      agency: notices.agency,
      outboundClicks: notices.outboundClicks,
    })
    .from(notices)
    .where(sql`${notices.outboundClicks} > 0`)
    .orderBy(desc(notices.outboundClicks), asc(notices.id))
    .limit(limit);
  return rows;
}

/**
 * 出站提意点击按日期聚合（每日总点击数，日期倒序，limit 默认最近 30 个有点击的日期）。
 * 数据源为 outbound_click_daily 按日聚合表（只含条目 × 日期两个维度，无个人身份）。
 */
export async function getClicksByDate(limit = 30): Promise<ClickDateTotal[]> {
  const db = await getDb();
  const rows = await db
    .select({
      date: outboundClickDaily.clickDate,
      clicks: sql<number>`sum(${outboundClickDaily.clicks})`,
    })
    .from(outboundClickDaily)
    .groupBy(outboundClickDaily.clickDate)
    .orderBy(desc(outboundClickDaily.clickDate))
    .limit(limit);
  return rows.map((row) => ({ date: row.date, clicks: Number(row.clicks) }));
}

/**
 * 概览数字：收录条目总数 + 累计出站提意点击（北极星指标总量）。
 * 单条聚合查询一次取回（双方言均支持 count / sum / coalesce）。
 */
export async function getStatsOverview(): Promise<StatsOverview> {
  const db = await getDb();
  const rows = await db
    .select({
      totalNotices: sql<number>`count(*)`,
      totalClicks: sql<number>`coalesce(sum(${notices.outboundClicks}), 0)`,
    })
    .from(notices);
  const row = rows[0];
  return {
    totalNotices: Number(row.totalNotices),
    totalClicks: Number(row.totalClicks),
  };
}

/**
 * 公示期长度分布（截止日期 - 发布日期的天数，按日历日分桶）：
 * ≤7 / 8-15 / 16-30 / >30 天。日期是 ISO 字符串，天数差在应用层计算
 * （双方言交集内无可移植的天数差 SQL 函数）；缺失任一日期或解析失败的
 * 条目不参与分布（记录在 total 标注的参与数之外）。
 */
export async function getPeriodLengthDistribution(): Promise<
  { key: PeriodBucketKey; count: number }[]
> {
  const db = await getDb();
  const rows = await db
    .select({ publishedAt: notices.publishedAt, deadlineAt: notices.deadlineAt })
    .from(notices)
    .where(and(isNotNull(notices.publishedAt), isNotNull(notices.deadlineAt)));

  const counts: Record<PeriodBucketKey, number> = { lte7: 0, b8_15: 0, b16_30: 0, gt30: 0 };
  for (const row of rows) {
    const days = calendarDaysBetween(row.publishedAt, row.deadlineAt);
    if (days === null) continue;
    if (days <= 7) counts.lte7 += 1;
    else if (days <= 15) counts.b8_15 += 1;
    else if (days <= 30) counts.b16_30 += 1;
    else counts.gt30 += 1;
  }
  return PERIOD_BUCKET_ORDER.map((key) => ({ key, count: counts[key] }));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 两个 ISO 日期（YYYY-MM-DD）之间的日历天数：b - a；任一为空或非日期返回 null。
 * 与 src/lib/dates.ts 的倒计时同口径（UTC 日历日差，避免时区与夏令时漂移）。
 */
function calendarDaysBetween(a: string | null, b: string | null): number | null {
  const aUtc = isoDateToUtc(a);
  const bUtc = isoDateToUtc(b);
  if (aUtc === null || bUtc === null) return null;
  return Math.round((bUtc - aUtc) / DAY_MS);
}

function isoDateToUtc(text: string | null): number | null {
  if (!text) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}
