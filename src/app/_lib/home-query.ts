/**
 * 首页 querystring 的解析（issue #41）：**页面渲染与 generateMetadata 共用同一份**。
 *
 * 为什么抽出来：索引口径要判断「这一页是不是筛选视图、第几页」，而渲染要判断
 * 「筛选后共 N 条」与翻页链接 —— 两处各写一遍解析必然分叉（issue #32/#33 的教训：
 * 同一个口径有两份实现，迟早给出相反答案）。这里只放纯解析，不碰数据库。
 */

import { isKnownCategory } from '../../lib/categories.ts';

/** 首页接受的 querystring 参数（Next 的 searchParams 形状：值可能是数组）。 */
export interface HomeSearchParams {
  category?: string | string[];
  agency?: string | string[];
  q?: string | string[];
  lead?: string | string[];
  page?: string | string[];
  month?: string | string[];
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

/** 首页当前生效的查询状态 */
export interface HomeQuery {
  /** 领域标签（未知值不生效：避免任意 querystring 触发无效筛选） */
  category?: string;
  agency?: string;
  keyword?: string;
  /** 机关筛选只算牵头机关（issue #36，统计页钻取链接带 lead=1 进来） */
  leadAgencyOnly: boolean;
  /** 发布月份（YYYY-MM，issue #45：统计页趋势表钻取用） */
  month?: string;
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
  const month = monthParam(params.month);
  return {
    category,
    agency,
    keyword,
    month,
    leadAgencyOnly: firstParam(params.lead) === '1',
    page: pageParam(params.page),
    hasFilter:
      category !== undefined ||
      agency !== undefined ||
      keyword !== undefined ||
      month !== undefined,
  };
}
