import { confirmSubscriptionByToken } from '@/db/repo/subscriptions';

/**
 * 订阅确认动作端点（issue #52）：POST /subscribe/confirm/submit?token=…
 *
 * - **POST**：执行确认（幂等）→ 303 到 `/subscribe/confirmed`；
 *   两种调用方都走这里：① 确认页上的「确认订阅」按钮（token 在表单字段里）；
 *   ② 脚本 / 邮件客户端预取 POST（RFC 无关，token 一律取查询串或表单字段）。
 * - **GET**：303 跳回确认页。存在的意义是「万一有人手敲这个地址」落在正确的地方，
 *   而不是 405；也保证任何 GET 都不写库。
 *
 * 为什么确认动作不在 `GET /subscribe/confirm` 上：邮件安全网关会预取邮件里的链接，
 * GET 直接确认会让用户在不知情的情况下被订阅（详见 app/subscribe/confirm/page.tsx）。
 *
 * 为什么本端点与确认页分成两个目录：App Router 不允许同一段同时存在 page.tsx
 * 与 route.ts，而确认页（GET，只读）与动作端点（POST，写库）必须是两个地址。
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

/** 取 token：查询串优先，其次表单字段（确认页的表单把 token 放在隐藏字段里）。 */
async function tokenOf(request: Request): Promise<string> {
  const fromQuery = new URL(request.url).searchParams.get('token');
  if (fromQuery !== null && fromQuery.trim() !== '') return fromQuery.trim();
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const form = await request.formData();
    return String(form.get('token') ?? '').trim();
  }
  return '';
}

export async function POST(request: Request): Promise<Response> {
  const result = await confirmSubscriptionByToken(await tokenOf(request));
  switch (result) {
    case 'confirmed':
      return redirectTo('/subscribe/confirmed');
    case 'unsubscribed':
      return redirectTo('/subscribe/confirmed?state=unsubscribed');
    default:
      return redirectTo('/subscribe/confirmed?state=invalid');
  }
}

export async function GET(request: Request): Promise<Response> {
  const token = await tokenOf(request);
  return redirectTo(
    token === '' ? '/subscribe/confirm' : `/subscribe/confirm?token=${encodeURIComponent(token)}`,
  );
}
