/**
 * 订阅表单草稿（issue #53）。
 *
 * 要解决的问题：表单提交失败后已填内容全丢 —— 错误经 303 回到
 * `/subscribe?error=…`，页面只渲染一条横幅，邮箱、关键词、勾选的领域都要重填。
 * 而**不能**把值塞进查询串：邮箱会落进地址栏、浏览器历史、服务器访问日志，以及
 * 点外链时带出去的 Referer 头 —— 与本站「只存订阅邮箱、不留身份痕迹」的口径冲突。
 *
 * 做法：POST 失败时把草稿写进一个短命 cookie（HttpOnly、120 秒、Path=/subscribe，
 * 只在这个路径上存在），页面读它当 defaultValue；提交成功时立刻清掉。
 * 已知取舍：120 秒内再次打开 /subscribe 会看到上次的草稿（比起每次重填一遍，
 * 这个代价小得多，且草稿从不进入 URL）。
 *
 * **刻意不加 `Secure`**：本地开发与 e2e 都跑在 http 上，带 Secure 的 cookie 浏览器
 * 根本不写、测试会全红（issue #52 在会话 cookie 上踩过这个坑）。这个 cookie 里
 * 没有凭据 —— 只有用户自己刚敲进去的邮箱与关键词，且 http 下表单本身也是明文，
 * 加 Secure 不改变任何实际暴露面。
 */

export const SUBSCRIBE_DRAFT_COOKIE = 'subscribe_draft';
export const SUBSCRIBE_DRAFT_MAX_AGE_SECONDS = 120;

export interface SubscribeDraft {
  email: string;
  keywords: string;
  categories: string[];
  /** 勾选的发布机关（issue #60 第 2 刀） */
  agencies: string[];
  /** 订阅范围原始值（'rules' / 'all'），回填单选框用 */
  scope: string;
}

/** 长度上限（RFC 5321 的邮箱上限 + 给关键词与领域留足余量），同时保证 cookie 远小于 4KB。 */
const MAX_EMAIL = 254;
const MAX_KEYWORDS = 300;
const MAX_CATEGORIES = 20;
const MAX_AGENCIES = 30;

export function hasDraftContent(draft: SubscribeDraft): boolean {
  return (
    draft.email !== ''
    || draft.keywords !== ''
    || draft.categories.length > 0
    || draft.agencies.length > 0
    // scope 单独为 'all' 也算有内容：那是用户明确选的范围，不该被当成空草稿丢掉
    || draft.scope === 'all'
  );
}

export function encodeSubscribeDraft(draft: SubscribeDraft): string {
  const capped: SubscribeDraft = {
    email: draft.email.slice(0, MAX_EMAIL),
    keywords: draft.keywords.slice(0, MAX_KEYWORDS),
    categories: draft.categories.slice(0, MAX_CATEGORIES),
    agencies: draft.agencies.slice(0, MAX_AGENCIES),
    scope: draft.scope === 'all' ? 'all' : 'rules',
  };
  return Buffer.from(JSON.stringify(capped), 'utf8').toString('base64url');
}

/**
 * 解码草稿：任何形状不对的输入都返回 null（cookie 是客户端可控的输入，
 * 页面只是拿它做 defaultValue，解析失败就当没有草稿，绝不让它打断渲染）。
 */
export function decodeSubscribeDraft(raw: string | undefined): SubscribeDraft | null {
  if (raw === undefined || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const draft: SubscribeDraft = {
      email: typeof record.email === 'string' ? record.email.slice(0, MAX_EMAIL) : '',
      keywords: typeof record.keywords === 'string' ? record.keywords.slice(0, MAX_KEYWORDS) : '',
      categories: Array.isArray(record.categories)
        ? record.categories
            .filter((value): value is string => typeof value === 'string')
            .slice(0, MAX_CATEGORIES)
        : [],
      agencies: Array.isArray(record.agencies)
        ? record.agencies
            .filter((value): value is string => typeof value === 'string')
            .slice(0, MAX_AGENCIES)
        : [],
      scope: record.scope === 'all' ? 'all' : 'rules',
    };
    return hasDraftContent(draft) ? draft : null;
  } catch {
    return null;
  }
}

/** 写入草稿的 Set-Cookie 值。 */
export function subscribeDraftCookie(draft: SubscribeDraft): string {
  return [
    `${SUBSCRIBE_DRAFT_COOKIE}=${encodeSubscribeDraft(draft)}`,
    'Path=/subscribe',
    `Max-Age=${SUBSCRIBE_DRAFT_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ].join('; ');
}

/** 清除草稿的 Set-Cookie 值（提交成功后调用，避免下次访问看到旧草稿）。 */
export function clearedSubscribeDraftCookie(): string {
  return `${SUBSCRIBE_DRAFT_COOKIE}=; Path=/subscribe; Max-Age=0; HttpOnly; SameSite=Lax`;
}
