import type { NoticeRecord, SubscriptionRecord, SubscriptionScope } from '../db/types.ts';
import { canonicalAgency, splitAgencies } from './agencies.ts';
import { DOMAIN_CATEGORIES } from './categories.ts';

/**
 * 订阅规则（issue #7 建立，issue #60 第 2 刀加「按机关」与「全部新公示」两种范围）。
 * 纯函数实现 —— 订阅页输入校验、提醒任务与新公示通知**共用同一份匹配逻辑**。
 * 这条同源是刻意的：三处各写一份的话，"订阅了却收不到"就没有可解释的版本了。
 */

/**
 * 订阅表单可选的领域清单（issue #9 起与条目 categoryTags 同源：
 * 取自 src/lib/categories.ts 的领域标签体系，条目打标与订阅领域共用一份词表）。
 */
export const CATEGORY_OPTIONS: readonly string[] = DOMAIN_CATEGORIES.map(
  (domain) => domain.label,
);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_KEYWORDS = 20;
const MAX_KEYWORD_LENGTH = 50;
/** 机关订阅上限：比关键词宽，因为"订全部联合发文机关里的几家"是很自然的用法。 */
const MAX_AGENCIES = 30;
const MAX_AGENCY_LENGTH = 60;

/** 校验并规范化订阅邮箱（统一小写）；非法返回 null。 */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return null;
  if (!EMAIL_PATTERN.test(email)) return null;
  return email;
}

/**
 * 解析关键词输入：按空白 / 中英文逗号 / 顿号 / 分号 / 换行切分，
 * 去重、去空、限制数量与长度。
 */
export function normalizeKeywords(raw: string): string[] {
  const keywords = raw
    .split(/[\s,，、;；\n]+/)
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0 && keyword.length <= MAX_KEYWORD_LENGTH);
  return [...new Set(keywords)].slice(0, MAX_KEYWORDS);
}

/**
 * 解析机关输入：按空白 / 逗号 / 顿号 / 分号 / 换行切分，逐个走 `canonicalAgency`
 * （别名收敛 + 压空白），去重、去空、限数量与长度。
 *
 * 归一化必须与**入库时推导条目机关**用的是同一个函数，否则会出现
 * 「用户订了中国民航局，条目写的是中国民用航空局」这种永远匹配不上的订阅。
 */
export function normalizeAgencies(raw: string | string[]): string[] {
  const list = (Array.isArray(raw) ? raw : raw.split(/[\s,，、;；\n]+/))
    .map((item) => canonicalAgency(String(item)))
    .filter((item) => item.length > 0 && item.length <= MAX_AGENCY_LENGTH);
  return [...new Set(list)].slice(0, MAX_AGENCIES);
}

/** 订阅范围解析：只认 'all'，其余（含缺省、拼错）一律按 'rules'。 */
export function normalizeScope(raw: string | null | undefined): SubscriptionScope {
  return String(raw ?? '').trim().toLowerCase() === 'all' ? 'all' : 'rules';
}

/** 校验规则是否非空（范围=按条件时，至少要有一条）。 */
export function hasAnyRule(rules: {
  keywords: string[];
  categories: string[];
  agencies: string[];
}): boolean {
  return rules.keywords.length > 0 || rules.categories.length > 0 || rules.agencies.length > 0;
}

/** 校验规则：至少一个关键词 / 一个领域 / 一个机关（或显式选了「全部新公示」）；领域必须是已知清单内的值。 */
export function validateSubscriptionRules(
  keywords: string[],
  categories: string[],
  agencies: string[] = [],
  scope: SubscriptionScope = 'rules',
): { ok: true } | { ok: false; reason: 'no_rules' | 'unknown_category' | 'unknown_agency' } {
  if (scope === 'all') return { ok: true };
  if (!hasAnyRule({ keywords, categories, agencies })) return { ok: false, reason: 'no_rules' };
  const known = new Set<string>(CATEGORY_OPTIONS);
  if (categories.some((category) => !known.has(category))) {
    return { ok: false, reason: 'unknown_category' };
  }
  return { ok: true };
}

/** 规则匹配的最小条目形状（便于测试与复用）。 */
export type RuleMatchableNotice = Pick<NoticeRecord, 'title' | 'bodyText' | 'categoryTags' | 'agency'>;

/** 规则匹配的最小订阅形状。 */
export type RuleMatchableSubscription = Pick<
  SubscriptionRecord,
  'keywords' | 'categories' | 'agencies' | 'scope'
>;

/**
 * 订阅规则是否命中条目：
 * - `scope = 'all'` 一律命中（用户显式要全部新公示）；
 * - 否则任一领域命中领域标签、任一机关命中该条目的**参与机关集合**（联合发文按每一个
 *   参与机关算，与 issue #21 的筛选口径同源）、任一关键词出现在标题或正文。
 * 一条规则都没有且不订全部 ⇒ 不命中任何条目（表单已强制，这里是防御）。
 */
export function matchesSubscriptionRules(
  subscription: RuleMatchableSubscription,
  notice: RuleMatchableNotice,
): boolean {
  if (subscription.scope === 'all') return true;

  const hasKeywordRules = subscription.keywords.length > 0;
  const hasCategoryRules = subscription.categories.length > 0;
  const hasAgencyRules = (subscription.agencies ?? []).length > 0;
  if (!hasKeywordRules && !hasCategoryRules && !hasAgencyRules) return false;

  if (hasCategoryRules) {
    const tags = new Set(notice.categoryTags);
    if (subscription.categories.some((category) => tags.has(category))) return true;
  }

  if (hasAgencyRules) {
    // 逐个精确相等，不做子串：「司法部」不该命中「司法部办公厅」
    const noticeAgencies = new Set(splitAgencies(notice.agency));
    if (subscription.agencies.some((agency) => noticeAgencies.has(agency))) return true;
  }

  if (hasKeywordRules) {
    const title = notice.title.toLowerCase();
    const body = (notice.bodyText ?? '').toLowerCase();
    return subscription.keywords.some(
      (keyword) => title.includes(keyword.toLowerCase()) || body.includes(keyword.toLowerCase()),
    );
  }
  return false;
}
