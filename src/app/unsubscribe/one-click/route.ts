import { unsubscribeByToken } from '@/db/repo/subscriptions';

/**
 * 退订动作端点（issue #34）：POST /unsubscribe/one-click?token=…
 *
 * - **POST**：执行退订（幂等）→ 303 到 `/unsubscribe/done?ok=1`；token 无效 → `ok=0`。
 *   两种调用方都走这里：① 退订确认页（`/unsubscribe`）上的「确认退订」按钮
 *   （token 在表单字段里）；② 邮件客户端自带的「退订」按钮 —— 邮件头带了
 *   `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
 *   （RFC 8058），客户端会带着 `List-Unsubscribe=One-Click` 请求体 POST 到本地址，
 *   请求体不参与判定，token 一律取查询串或表单字段。
 * - **GET**：303 跳回确认页。存在的意义是「邮件头里的地址也要能被人点开」——
 *   不支持一键退订的客户端会把 `List-Unsubscribe` 的地址展示给用户，
 *   落在确认页上才是正确姿势（而不是 405 或直接退订）。
 *
 * 为什么退订动作不在 `GET /unsubscribe` 上：邮件安全网关会预取邮件里的链接，
 * GET 直接退订会让用户在不知情的情况下被退订（详见 app/unsubscribe/page.tsx 注释）。
 *
 * 为什么本端点与确认页分成两个目录：App Router 不允许同一段同时存在 page.tsx
 * 与 route.ts，而确认页（GET，只读）与动作端点（POST，写库）必须是两个地址。
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
  const result = await unsubscribeByToken(await tokenOf(request));
  return redirectTo(result === 'done' ? '/unsubscribe/done?ok=1' : '/unsubscribe/done?ok=0');
}

export async function GET(request: Request): Promise<Response> {
  const token = await tokenOf(request);
  return redirectTo(
    token === '' ? '/unsubscribe' : `/unsubscribe?token=${encodeURIComponent(token)}`,
  );
}
