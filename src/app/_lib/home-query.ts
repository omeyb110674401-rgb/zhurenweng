/**
 * 首页 querystring 的解析（issue #41）：**页面渲染与 generateMetadata 共用同一份**。
 *
 * 为什么抽出来：索引口径要判断「这一页是不是筛选视图、第几页」，而渲染要判断
 * 「筛选后共 N 条」与翻页链接 —— 两处各写一遍解析必然分叉（issue #32/#33 的教训：
 * 同一个口径有两份实现，迟早给出相反答案）。这里只放纯解析，不碰数据库。
 */

import { isKnownCategory } from '../../lib/categories.ts';
import { isPeriodBucketKey, type PeriodBucketKey } from '../../lib/notice-period.ts';

/** 首页接受的 querystring 参数（Next 的 searchParams 形状：值可能是数组）。 */
export interface HomeSearchParams {
  category?: string | string[];
  agency?: string | string[];
  q?: string | string[];
  lead?: string | string[];
  page?: string | string[];
  month?: string | string[];
  from?: string | string[];
  to?: string | string[];
  period?: string | string[];
}

/** 取 querystring 参数首值并去空白；空串视为未传。 */
export function firstParam(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** 取 querystring 里的页码：非正整数一律当作第 1 页（不报错、不空页）。 */
export function pageParam(value: string | string[] | undefined): number {
  const parsed = Number(firstParam(value) ?? '1');
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * 取 querystring 里的发布月份（YYYY-MM，issue #45）：格式非法一律不生效 ——
 * 与未知领域值同一处理（任意 querystring 不该触发无效筛选）。
 *
 * 为什么要有这一维：统计页「公示量月度趋势」表的每个格子都是一个可核对的数字，
 * 但首页筛选此前表达不了「某月」，所以那 96 个数字全是死文本（issue #36 定的
 * 规矩是「统计页每个数字都应可点开，且点进去的条数 = 表格数字」）。
 */
export function monthParam(value: string | string[] | undefined): string | undefined {
  const raw = firstParam(value);
  if (raw === undefined) return undefined;
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) ? raw : undefined;
}

/**
 * 取 querystring 里的发布月份区间（issue #48）：两端都必须是 YYYY-MM。
 *
 * 为什么需要区间：统计页趋势表的「小计 / 总计」是**窗口内的求和**（最近 6 个月），
 * 单个 `?month=` 表达不了它 —— 而 #36 定的规矩是每个数字点开后条数必须与表格一致。
 *
 * 规矩（都是「宁可不筛，也不给假空态」）：
 * - 只给一端也有效（`from` 或 `to` 单独用）；
 * - 两端都给且 `from > to` → 两端都不生效（手改 URL 把顺序写反是常见事，
 *   不该因此看到一页「筛选后共 0 条」）；
 * - 任一端格式非法 → 该端不生效（与未知领域值同一处理）。
 *
 * 兼容：`?month=YYYY-MM` 是 `from = to = 该月` 的**别名**（issue #45 已发布的钻取
 * 链接保持有效）。SQL 侧只有区间一条路径，别名在解析层折平 —— 不养两套口径。
 */
export function monthRangeParam(
  fromRaw: string | string[] | undefined,
  toRaw: string | string[] | undefined,
): { from?: string; to?: string } {
  const from = monthParam(fromRaw);
  const to = monthParam(toRaw);
  if (from !== undefined && to !== undefined && from > to) return {};
  return { from, to };
}

/**
 * 取 querystring 里的公示期分桶（issue #47）：只认 `notice-period.ts` 里定义的
 * 桶 key（`lte7` / `b8_15` / `b16_30` / `gt30`），其余一律不生效 —— 与未知领域值
 * 同一处理。桶的边界与文案也来自那份定义，这里不重复一套。
 */
export function periodParam(value: string | string[] | undefined): PeriodBucketKey | undefined {
  const raw = firstParam(value);
  if (raw === undefined) return undefined;
  return isPeriodBucketKey(raw) ? raw : undefined;
}

/** 首页当前生效的查询状态 */
export interface HomeQuery {
  /** 领域标签（未知值不生效：避免任意 querystring 触发无效筛选） */
  category?: string;
  agency?: string;
  keyword?: string;
  /** 机关筛选只算牵头机关（issue #36，统计页钻取链接带 lead=1 进来） */
  leadAgencyOnly: boolean;
  /** 发布月份区间下界（YYYY-MM，issue #48：趋势表小计 / 总计钻取用） */
  from?: string;
  /** 发布月份区间上界（YYYY-MM，含该月） */
  to?: string;
  /** 公示期分桶 key（issue #47：统计页公示期分布钻取用） */
  period?: PeriodBucketKey;
  /** 请求的页码（已夹到正整数；实际页码还要按总数夹一次） */
  page: number;
  /** 是否带了筛选维度（领域 / 机关 / 关键词 / 月份）—— 决定「筛选后共 N 条」与索引口径 */
  hasFilter: boolean;
}

/** 解析首页 querystring。 */
export function parseHomeQuery(params: HomeSearchParams): HomeQuery {
  const categoryParam = firstParam(params.category);
  const category = categoryParam !== undefined && isKnownCategory(categoryParam) ? categoryParam : undefined;
  const agency = firstParam(params.agency);
  const keyword = firstParam(params.q);
  // 区间优先；两端都没给时才认旧别名 `?month=`（折平为 from = to，issue #45 的
  // 旧链接保持有效）。半区间 + 别名的组合**不拼**：`?from=2026-01&month=2026-03`
  // 若折平上界，就凭空造出一个谁也没要求的区间 —— 与本模块「宁可不筛，也不给
  // 假空态」的规矩相悖（用户看到的是「发布区间：2026-01 至 2026-03」，而他只
  // 指定了一个起点和一个互不相干的月份别名）。
  const range = monthRangeParam(params.from, params.to);
  const hasRange = range.from !== undefined || range.to !== undefined;
  const legacyMonth = hasRange ? undefined : monthParam(params.month);
  const from = range.from ?? legacyMonth;
  const to = range.to ?? legacyMonth;
  const period = periodParam(params.period);
  return {
    category,
    agency,
    keyword,
    from,
    to,
    period,
    leadAgencyOnly: firstParam(params.lead) === '1',
    page: pageParam(params.page),
    hasFilter:
      category !== undefined ||
      agency !== undefined ||
      keyword !== undefined ||
      from !== undefined ||
      to !== undefined ||
      period !== undefined,
  };
}
