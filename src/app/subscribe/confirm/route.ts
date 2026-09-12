import { confirmSubscriptionByToken } from '@/db/repo/subscriptions';

/**
 * 订阅确认端点（issue #7，double opt-in 第二步）：GET /subscribe/confirm?token=…
 *
 * 确认邮件中的链接指向这里：校验 token → 订阅生效 → 303 到结果页。
 * 已退订的订阅不可通过确认复活；token 缺失 / 无效同样落到结果页的失败态。
 */

// 确认必须实时写库，禁止静态优化与缓存。
export const dynamic = 'force-dynamic';

/**
 * 303 重定向（相对 Location）：自定义服务器 / 反代场景下 request.url 的
 * origin 不可靠，相对路径由客户端按当前地址解析。
 */
function redirectTo(path: string): Response {
  return new Response(null, { status: 303, headers: { location: path } });
}

export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  const result = await confirmSubscriptionByToken(token);
  switch (result) {
    case 'confirmed':
      return redirectTo('/subscribe/confirmed');
    case 'unsubscribed':
      return redirectTo('/subscribe/confirmed?state=unsubscribed');
    default:
      return redirectTo('/subscribe/confirmed?state=invalid');
  }
}
