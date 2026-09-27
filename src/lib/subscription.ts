import type { NoticeRecord, SubscriptionRecord, SubscriptionScope } from '../db/types.ts';
import { canonicalAgency, splitAgencies } from './agencies.ts';
import { AUDIENCE_HINTS, AUDIENCE_LABELS, SUBSCRIBABLE_AUDIENCES, isSubscribableAudience } from './audience.ts';
import type { NoticeAudience } from './audience.ts';
import { DOMAIN_CATEGORIES } from './categories.ts';

/**
 * 订阅规则（issue #7 建立，issue #60 第 2 刀加「按机关」与「全部新公示」两种范围，
 * issue #84 加「按受众面」这一层收窄）。
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

/**
 * 订阅表单可选的受众面（issue #84）：**只有两档，刻意不含「未判定」**。
 *
 * 不是遗漏：受众面在这里是**收窄**条件，"未判定"不是一个人会有的意图 ——
 * 没有人会说"请把你们没归好类的那批发给我"，而想全都收的人本来就**什么都不勾**
 * （空 = 不限）。把未判定摆上表单，只会让人以为不勾它就会漏掉什么。
 *
 * 取值与展示名直接取自 `audience.ts`：列表页筛选、详情页角标、订阅表单三处
 * 用同一份中文，改口径时不会只剩一处不跟。
 */
export const AUDIENCE_OPTIONS: readonly { value: NoticeAudience; label: string; hint: string }[] =
  SUBSCRIBABLE_AUDIENCES.map((value) => ({
    value,
    label: AUDIENCE_LABELS[value],
    hint: AUDIENCE_HINTS[value],
  }));

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

/**
 * 解析受众面输入：trim + 小写，只认已知档（白名单外的值直接丢掉，不当成新档），
 * 去重后按表单顺序返回。上限就是可选档数 —— 这里没有"多填几个"的用法。
 */
export function normalizeAudiences(raw: string | string[] | null | undefined): NoticeAudience[] {
  // 数组与字符串两种入参**都要再切一次**：表单交来的是 `getAll('audiences')`（数组），
  // 而手输 / 手工拼串时是一个字符串里带分隔符。只切其中一种的后果是另一种被当成
  // 单个未知值整条丢掉 —— 表现为"勾了公众广域却什么都没订上"，且没有任何报错。
  const list = (Array.isArray(raw) ? raw : [raw ?? ''])
    .flatMap((item) => String(item).split(/[\s,，、;；]+/));
  const picked = list
    .map((item) => item.trim().toLowerCase())
    .filter(isSubscribableAudience);
  return [...new Set(picked)].slice(0, AUDIENCE_OPTIONS.length);
}

/** 订阅范围解析：只认 'all'，其余（含缺省、拼错）一律按 'rules'。 */
export function normalizeScope(raw: string | null | undefined): SubscriptionScope {
  return String(raw ?? '').trim().toLowerCase() === 'all' ? 'all' : 'rules';
}

/**
 * 校验规则是否非空（范围=按条件时，至少要有一条）。
 *
 * 受众面**单独出现也算有规则**（issue #84）：「只订公众广域的全部新公示」是一个
 * 完整的、说得出口的订阅意图，而它恰好是那种"影响面广、我想都看一眼"的用法。
 */
export function hasAnyRule(rules: {
  keywords: string[];
  categories: string[];
  agencies: string[];
  audiences?: NoticeAudience[];
}): boolean {
  return (
    rules.keywords.length > 0
    || rules.categories.length > 0
    || rules.agencies.length > 0
    || (rules.audiences ?? []).length > 0
  );
}

/** 校验规则：至少一个关键词 / 一个领域 / 一个机关 / 一档受众面（或显式选了「全部新公示」）；领域必须是已知清单内的值。 */
export function validateSubscriptionRules(
  keywords: string[],
  categories: string[],
  agencies: string[] = [],
  scope: SubscriptionScope = 'rules',
  audiences: NoticeAudience[] = [],
): { ok: true } | { ok: false; reason: 'no_rules' | 'unknown_category' | 'unknown_agency' | 'unknown_audience' } {
  if (scope === 'all') return { ok: true };
  if (!hasAnyRule({ keywords, categories, agencies, audiences })) {
    return { ok: false, reason: 'no_rules' };
  }
  const known = new Set<string>(CATEGORY_OPTIONS);
  if (categories.some((category) => !known.has(category))) {
    return { ok: false, reason: 'unknown_category' };
  }
  // 受众面在**解析阶段**就已按白名单过滤（normalizeAudiences），所以这里判不出来才对；
  // 留着这一支是为了「过滤被谁删掉」这件事变成一个测试能抓住的红，而不是静默放宽。
  if (audiences.some((audience) => !isSubscribableAudience(audience))) {
    return { ok: false, reason: 'unknown_audience' };
  }
  return { ok: true };
}

/** 规则匹配的最小条目形状（便于测试与复用）。 */
export type RuleMatchableNotice = Pick<
  NoticeRecord,
  'title' | 'bodyText' | 'categoryTags' | 'agency' | 'audience'
>;

/** 规则匹配的最小订阅形状。 */
export type RuleMatchableSubscription = Pick<
  SubscriptionRecord,
  'keywords' | 'categories' | 'agencies' | 'audiences' | 'scope'
>;

/**
 * 受众面收窄条件是否满足（issue #84）：空 = 不限（`?? []` 让"没有这个字段"的调用方
 * —— 以及本列上线前建的订阅 —— 与旧行为逐条一致）。
 *
 * 条目的受众面是 `unknown` 或尚未判定（NULL）时**不算任何一档**：勾了受众面的订阅
 * 收不到它们。这条是有意的 —— 若把"判不出来"也算进公众广域，那一档就会混进
 * 技术标准与行业规程，而"公众广域"这个名字本身就是给读者的承诺。
 */
function matchesAudienceFilter(
  subscription: RuleMatchableSubscription,
  notice: RuleMatchableNotice,
): boolean {
  const wanted = subscription.audiences ?? [];
  if (wanted.length === 0) return true;
  const audience = notice.audience;
  if (audience === null || audience === undefined) return false;
  return wanted.includes(audience);
}

/**
 * 订阅规则是否命中条目：
 * - 受众面是**收窄条件**，先判，且对 `scope='all'` 同样生效（见下）；
 * - `scope = 'all'` 一律命中（用户显式要全部新公示）；
 * - 否则任一领域命中领域标签、任一机关命中该条目的**参与机关集合**（联合发文按每一个
 *   参与机关算，与 issue #21 的筛选口径同源）、任一关键词出现在标题或正文。
 * 一条规则都没有且不订全部 ⇒ 不命中任何条目（表单已强制，这里是防御）。
 */
export function matchesSubscriptionRules(
  subscription: RuleMatchableSubscription,
  notice: RuleMatchableNotice,
): boolean {
  // 这三项（关键词 / 领域 / 机关）回答的是"这条跟我有没有关系"，任一命中即相关；
  // 受众面回答的是"这类公示是不是给我看的" —— 是不同的问法，所以它是 AND 而不是
  // "又一档命中即可"。顺序也重要：它必须排在 scope='all' **之前**，
  // 否则"订全部 + 只看公众广域"的人会收到全部，而我们嘴上说的却是收窄。
  if (!matchesAudienceFilter(subscription, notice)) return false;

  if (subscription.scope === 'all') return true;

  const hasKeywordRules = subscription.keywords.length > 0;
  const hasCategoryRules = subscription.categories.length > 0;
  const hasAgencyRules = (subscription.agencies ?? []).length > 0;
  const hasAudienceRules = (subscription.audiences ?? []).length > 0;
  if (!hasKeywordRules && !hasCategoryRules && !hasAgencyRules && !hasAudienceRules) return false;

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
  // 只勾了受众面：条件在上面那道收窄里已经判过了（命中就是命中），
  // 这里返回 true 而不是 false —— 否则「只订公众广域」会是一条永远收不到信的订阅。
  return hasAudienceRules;
}
