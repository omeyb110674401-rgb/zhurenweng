/**
 * 「这条是什么时候被收录的」的口径（issue #62）。
 *
 * 判据只用 `notices.first_seen_at`，**不用** `fetched_at`：后者每天被抓取覆盖，
 * 用它会让三个月前的条目天天被判成「新增」（同一件事在 issue #60 的新公示通知里
 * 已经踩过一次，那里的注释写了原因）。
 *
 * 窗口刻意用**时刻**（`now - N*24h`）而不是「N 个站点日历日」：
 * `first_seen_at` 是 UTC 时间戳，而日历日属于东八区 —— 在 SQL 里取前 10 位比日期，
 * 边界会与页面用 JS 算出的日历日差 8 小时。仓储层的字符串比较和列表页的角标
 * 因此会给出相反的答案（同一条既「在近 7 天内」又不标「新」）。用同一个时刻下界
 * 判两处，规则只有一份实现。代价是「近 7 天」是滚动的 168 小时而非 7 个北京日历日
 * —— 对「最近新增」这个用法，滚动窗口是可接受的读法，且不会在半夜跳变。
 */

/** 列表项「新」角标的窗口（与 `?since=` 选的窗口无关：选 90 天时不该人人带角标）。 */
export const NEW_BADGE_DAYS = 7;

/** 首页提供的「最近新增」快捷窗口（天数）。 */
export const SINCE_OPTION_DAYS: readonly number[] = [7, 30, 90];

/** `?since=` 认的最大值；超过它等于「不限制收录时间」，故不再生效（见 sinceParam 的说明）。 */
export const MAX_SINCE_DAYS = Math.max(...SINCE_OPTION_DAYS);

const DAY_MS = 86_400_000;

/**
 * 「最近 N 天」的下界，形状与 `first_seen_at` 的写入值一致（`Date#toISOString()`）。
 *
 * 之所以返回字符串而不是让调用方各自 `toISOString()`：SQL 侧做的是**同形状字符串的
 * 字节序比较**（等价于时间先后），两侧格式一旦不同（有无 `Z`、有无毫秒）比较就会
 * 给出错误结果。把形状收在这一处，仓储层与页面用的是同一个下界。
 */
export function recencyCutoffIso(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

/**
 * 条目是否算「新增」（列表角标）。
 *
 * `first_seen_at` 为 NULL 的存量行（迁移 0013 之前入库、还没被重抓过）判为 false：
 * 宁可不标，也不把「不知道什么时候进来的」说成「新」。
 */
export function isNewNotice(
  firstSeenAt: string | null | undefined,
  now: Date,
  days: number = NEW_BADGE_DAYS,
): boolean {
  if (firstSeenAt == null) return false;
  const seenAt = Date.parse(firstSeenAt);
  if (Number.isNaN(seenAt)) return false;
  return seenAt >= Date.parse(recencyCutoffIso(now, days));
}
