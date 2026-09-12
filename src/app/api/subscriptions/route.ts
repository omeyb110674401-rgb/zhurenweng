import { buildConfirmationEmail } from '@/lib/mail';
import { createMailerPort } from '@/lib/ports';
import {
  CATEGORY_OPTIONS,
  normalizeEmail,
  normalizeKeywords,
  validateSubscriptionRules,
} from '@/lib/subscription';
import { upsertSubscriptionRules } from '@/db/repo/subscriptions';

/**
 * 订阅提交端点（issue #7，double opt-in 第一步）：POST /api/subscriptions
 *
 * 校验邮箱与规则 → 按邮箱 upsert 待确认订阅（同邮箱更新规则而非重复建行）→
 * 发送确认邮件（含确认链接与一键退订链接）→ 303 回订阅页展示结果横幅。
 * 已确认的订阅重复提交只更新规则，不重发确认邮件。
 */

// 每次提交都要实时读写库并发送邮件，禁止静态优化与缓存。
export const dynamic = 'force-dynamic';

/**
 * 303 重定向（相对 Location）：自定义服务器 / 反代场景下 request.url 的
 * origin 不可靠，相对路径由客户端按当前地址解析。
 */
function redirectTo(path: string): Response {
  return new Response(null, { status: 303, headers: { location: path } });
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();

  const email = normalizeEmail(String(form.get('email') ?? ''));
  if (email === null) {
    return redirectTo('/subscribe?error=invalid_email');
  }

  const keywords = normalizeKeywords(String(form.get('keywords') ?? ''));
  const categoryInput = form
    .getAll('categories')
    .map((value) => String(value))
    .filter((value) => (CATEGORY_OPTIONS as readonly string[]).includes(value));
  const rules = validateSubscriptionRules(keywords, categoryInput);
  if (!rules.ok) {
    return redirectTo(`/subscribe?error=${rules.reason}`);
  }

  const { subscription, outcome } = await upsertSubscriptionRules({
    email,
    keywords,
    categories: categoryInput,
    now: new Date(),
  });

  // 已确认的订阅只更新规则；其余结果都需要完成确认才能生效，发送确认邮件
  if (outcome !== 'confirmed-updated') {
    try {
      const mailer = createMailerPort();
      await mailer.send(
        buildConfirmationEmail({
          email: subscription.email,
          rules: subscription,
          confirmToken: subscription.confirmToken,
          unsubscribeToken: subscription.unsubscribeToken,
        }),
      );
    } catch (error) {
      console.error(
        `[subscribe] 确认邮件发送失败 email=${email}：${error instanceof Error ? error.message : String(error)}`,
      );
      return redirectTo('/subscribe?error=send_failed');
    }
    return redirectTo('/subscribe?sent=1');
  }

  return redirectTo('/subscribe?updated=1');
}
