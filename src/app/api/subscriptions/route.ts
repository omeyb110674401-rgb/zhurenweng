import { buildConfirmationEmail } from '@/lib/mail';
import { createMailerPort } from '@/lib/ports';
import {
  CATEGORY_OPTIONS,
  normalizeAgencies,
  normalizeAudiences,
  normalizeEmail,
  normalizeKeywords,
  normalizeScope,
  validateSubscriptionRules,
} from '@/lib/subscription';
import { upsertSubscriptionRules } from '@/db/repo/subscriptions';
import { mailerReady } from '@/lib/mailer-availability';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  clearedSubscribeDraftCookie,
  hasDraftContent,
  subscribeDraftCookie,
  type SubscribeDraft,
} from '@/lib/subscribe-draft';

/**
 * 订阅提交端点（issue #7，double opt-in 第一步）：POST /api/subscriptions
 *
 * 校验邮箱与规则 → 按邮箱 upsert 待确认订阅（同邮箱更新规则而非重复建行）→
 * 发送确认邮件（含确认链接与一键退订链接）→ 303 回订阅页展示结果横幅。
 * 已确认的订阅重复提交只更新规则，不重发确认邮件。
 *
 * 邮件端口门控（issue #17）：邮件通道未配置时直接回 mailer_unavailable，
 * 不写库、不发信 —— 否则会留下一条永远收不到确认邮件的待确认订阅。
 *
 * 限流与结果文案（issue #52）：这是**匿名可达且会真的发信**的端点 —— 不限流时
 * 任何人对任意邮箱反复提交，本站就成了一台以自己域名发信的放大器（进黑名单后连
 * 正常确认信都投不出去）。另外结果文案**不再区分**「已更新规则」与「已发送确认邮件」：
 * 那个区分等于给匿名者一个「该邮箱是否已确认订阅」的枚举 oracle（隐私泄露），
 * 统一成一句对两种分支都成立的话。
 *
 * 已知取舍（有意保留）：已确认订阅者只要别人知道其邮箱，规则就会被改写（规则是
 * 「订阅规则」不是身份凭据）。完整修复要给 subscriptions 加待确认规则暂存列 +
 * 两方言迁移，属单独一轮；见 docs/pending-issues/FOLLOWUPS.md。
 */

// 每次提交都要实时读写库并发送邮件，禁止静态优化与缓存。
export const dynamic = 'force-dynamic';

/**
 * 303 重定向（相对 Location）：自定义服务器 / 反代场景下 request.url 的
 * origin 不可靠，相对路径由客户端按当前地址解析。`setCookie` 直接给 Set-Cookie 值。
 */
function redirectTo(path: string, setCookie?: string): Response {
  const headers: Record<string, string> = { location: path };
  if (setCookie !== undefined) headers['set-cookie'] = setCookie;
  return new Response(null, { status: 303, headers });
}

/**
 * 校验失败时的重定向（issue #53）：把用户已填内容放进短命 cookie 带回订阅页。
 * 为什么不能走查询串（邮箱会进地址栏、历史、访问日志与 Referer）见
 * lib/subscribe-draft.ts。
 */
function redirectWithDraft(path: string, draft: SubscribeDraft): Response {
  return redirectTo(path, hasDraftContent(draft) ? subscribeDraftCookie(draft) : undefined);
}

export async function POST(request: Request): Promise<Response> {
  // 限流先于一切解析：超限的请求不读表单、不写库、不发信
  if (!checkRateLimit('subscribe', request).allowed) {
    return redirectTo('/subscribe?error=rate_limited');
  }

  // 非表单请求体（爬虫 POST JSON、扫描器探测、content-type 错配）会让 formData() 抛错，
  // 未捕获就是 500（issue #51）。这是**公开**端点，别让一个乱发的 POST 变成错误页：
  // 按「表单不合法」处理，回订阅页说明。
  const form = await request.formData().catch(() => null);
  if (form === null) {
    return redirectTo('/subscribe?error=invalid_form');
  }

  // 邮件通道未配置：直接拒绝，不写库不发信（issue #17）
  if (!mailerReady()) {
    return redirectTo('/subscribe?error=mailer_unavailable');
  }

  // 草稿（issue #53）：留**原始输入**（不是规范化后的值）—— 用户敲错的东西要原样
  // 还给他，否则「重新填写」变成「猜自己刚才写了什么」。
  const draft: SubscribeDraft = {
    email: String(form.get('email') ?? ''),
    keywords: String(form.get('keywords') ?? ''),
    categories: form.getAll('categories').map((value) => String(value)),
    agencies: form.getAll('agencies').map((value) => String(value)),
    audiences: form.getAll('audiences').map((value) => String(value)),
    scope: String(form.get('scope') ?? 'rules'),
  };

  const email = normalizeEmail(String(form.get('email') ?? ''));
  if (email === null) {
    return redirectWithDraft('/subscribe?error=invalid_email', draft);
  }

  const keywords = normalizeKeywords(String(form.get('keywords') ?? ''));
  const categoryInput = form
    .getAll('categories')
    .map((value) => String(value))
    .filter((value) => (CATEGORY_OPTIONS as readonly string[]).includes(value));
  // 机关不做"必须在已有清单内"的白名单过滤：机构名以库为准，页面下拉只是便捷输入；
  // 用户手输一个还没出现过的新机关，订阅该条正是他想要的（等该机关入库就自然命中）。
  const agencies = normalizeAgencies(form.getAll('agencies').map((value) => String(value)));
  // 受众面（issue #84）：与领域同一条白名单口径 —— 它决定给谁发信，未知取值一律丢掉
  // （`normalizeAudiences` 只认 audience.ts 里那两档；未判定刻意不是可订项）。
  const audiences = normalizeAudiences(form.getAll('audiences').map((value) => String(value)));
  const scope = normalizeScope(String(form.get('scope') ?? 'rules'));
  const rules = validateSubscriptionRules(keywords, categoryInput, agencies, scope, audiences);
  if (!rules.ok) {
    return redirectWithDraft(`/subscribe?error=${rules.reason}`, draft);
  }

  const { subscription } = await upsertSubscriptionRules({
    email,
    keywords,
    categories: categoryInput,
    agencies,
    audiences,
    scope,
    now: new Date(),
  });

  // **任何**结果都发确认邮件（issue #60 第 4 刀）：已确认订阅改规则也不再"直接生效"，
  // 否则知道某人邮箱就能静默改写其订阅（FOLLOWUPS #52 挂账的解法）。
  try {
    const mailer = createMailerPort();
    await mailer.send(
      buildConfirmationEmail({
        email: subscription.email,
        rules: subscription,
        pendingRules: subscription.pending,
        confirmToken: subscription.confirmToken,
        unsubscribeToken: subscription.unsubscribeToken,
      }),
    );
  } catch (error) {
    console.error(
      `[subscribe] 确认邮件发送失败 email=${email}：${error instanceof Error ? error.message : String(error)}`,
    );
    return redirectWithDraft('/subscribe?error=send_failed', draft);
  }

  // 两种结果回同一个参数（见文件头的防枚举说明）；成功即清掉草稿，
  // 免得 120 秒内再打开订阅页时看到上一轮的旧输入（issue #53）
  return redirectTo('/subscribe?sent=1', clearedSubscribeDraftCookie());
}
