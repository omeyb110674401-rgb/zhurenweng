import { unsubscribeByToken } from '@/db/repo/subscriptions';

/**
 * 一键退订端点（issue #7）：GET /unsubscribe?token=…
 *
 * 确认邮件与提醒邮件底部的退订链接都指向这里：按 token 退订（立即生效，
 * 幂等）→ 303 到退订结果页。退订后不再收到任何邮件。
 */

// 退订必须实时写库，禁止静态优化与缓存。
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
  const result = await unsubscribeByToken(token);
  return redirectTo(result === 'done' ? '/unsubscribe/done?ok=1' : '/unsubscribe/done?ok=0');
}
