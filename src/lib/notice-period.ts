/**
 * 公示期分桶（issue #46 / #47）：**边界与文案定义在同一处**，三处消费共用 ——
 * 统计页展示、分布聚合（`db/repo/stats.ts`）、首页筛选（`?period=`，以及
 * `db/repo/notices.ts` 里按驱动分支的天数表达式）。
 *
 * 为什么必须合并定义：issue #46 的缺陷正是「标签与边界各写一份」—— 桶边界是
 * `> 30`，而页面标签写「30 天以上」（中文含 30），30 这个数同时落在两个桶里，
 * 读者无法判断它算哪一桶。把 `label` 与 `minDays`/`maxDays` 放进同一条记录，
 * 这种漂移在结构上就不可能发生；单测再钉死「分桶不重叠、不留缝」。
 *
 * 口径：公示期 = 截止日期 − 发布日期（按**日历日**，与倒计时同一口径）。
 * `lte7` 不设下界：截止早于发布属数据异常，归入最短桶（与修复前的行为一致，
 * 线上实测 0 条）。任一侧缺日期或解析失败 → 不参与分布（也不被任何桶筛出来）。
 */

export type PeriodBucketKey = 'lte7' | 'b8_15' | 'b16_30' | 'gt30';

export interface PeriodBucketDef {
  key: PeriodBucketKey;
  /** 页面文案（与边界同一条记录，避免再次出现「标签与边界分家」） */
  label: string;
  /** 天数下界（含）；null = 不设下界 */
  minDays: number | null;
  /** 天数上界（含）；null = 不设上界 */
  maxDays: number | null;
}

/** 分桶定义（顺序即展示顺序）。 */
export const PERIOD_BUCKETS: readonly PeriodBucketDef[] = [
  { key: 'lte7', label: '7 天以内（含 7 天）', minDays: null, maxDays: 7 },
  { key: 'b8_15', label: '8-15 天', minDays: 8, maxDays: 15 },
  { key: 'b16_30', label: '16-30 天', minDays: 16, maxDays: 30 },
  { key: 'gt30', label: '31 天及以上', minDays: 31, maxDays: null },
];

/** querystring 取值是否合法桶 key（`?period=` 的校验用）。 */
export function isPeriodBucketKey(value: string): value is PeriodBucketKey {
  return PERIOD_BUCKETS.some((bucket) => bucket.key === value);
}

/** 某条桶的展示文案；未知 key 返回 null（不猜、不兜底成别的桶名）。 */
export function periodBucketLabel(key: string): string | null {
  return PERIOD_BUCKETS.find((bucket) => bucket.key === key)?.label ?? null;
}

/** 公示期天数 → 桶；天数不在任何桶内时抛错（定义必须覆盖全部整数）。 */
export function bucketOfDays(days: number): PeriodBucketKey {
  const bucket = PERIOD_BUCKETS.find(
    (candidate) =>
      (candidate.minDays === null || days >= candidate.minDays) &&
      (candidate.maxDays === null || days <= candidate.maxDays),
  );
  if (bucket === undefined) {
    // 只可能在 PERIOD_BUCKETS 被改坏（例如把某段天数漏掉）时发生 —— 静默归桶
    // 会让分布数字对不上，宁可当场炸
    throw new Error(`公示期 ${days} 天不落在任何桶内（PERIOD_BUCKETS 定义有缝）`);
  }
  return bucket.key;
}
