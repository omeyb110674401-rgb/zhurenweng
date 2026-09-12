import type { NoticeRecord, SubscriptionRecord } from '../db/types.ts';
import { DOMAIN_CATEGORIES } from './categories.ts';

/**
 * 订阅规则（issue #7）：关键词命中条目标题 / 正文，领域命中条目领域标签。
 * 纯函数实现 —— 订阅页输入校验与提醒任务的规则匹配共用同一份逻辑。
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

/** 校验规则：至少一个关键词或一个领域；领域必须是已知清单内的值。 */
export function validateSubscriptionRules(
  keywords: string[],
  categories: string[],
): { ok: true } | { ok: false; reason: 'no_rules' | 'unknown_category' } {
  if (keywords.length === 0 && categories.length === 0) return { ok: false, reason: 'no_rules' };
  const known = new Set<string>(CATEGORY_OPTIONS);
  if (categories.some((category) => !known.has(category))) {
    return { ok: false, reason: 'unknown_category' };
  }
  return { ok: true };
}

/** 规则匹配的最小条目形状（便于测试与复用）。 */
export type RuleMatchableNotice = Pick<NoticeRecord, 'title' | 'bodyText' | 'categoryTags'>;

/** 规则匹配的最小订阅形状。 */
export type RuleMatchableSubscription = Pick<SubscriptionRecord, 'keywords' | 'categories'>;

/**
 * 订阅规则是否命中条目：任一关键词出现在标题或正文（不区分大小写），
 * 或任一领域命中条目领域标签。两条规则都为空视为不命中任何条目
 * （订阅表单已强制至少一条规则，这里只是防御）。
 */
export function matchesSubscriptionRules(
  subscription: RuleMatchableSubscription,
  notice: RuleMatchableNotice,
): boolean {
  const hasKeywordRules = subscription.keywords.length > 0;
  const hasCategoryRules = subscription.categories.length > 0;
  if (!hasKeywordRules && !hasCategoryRules) return false;

  if (hasCategoryRules) {
    const tags = new Set(notice.categoryTags);
    if (subscription.categories.some((category) => tags.has(category))) return true;
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
