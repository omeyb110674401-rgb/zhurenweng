import { adminTokenEquals, configuredAdminToken, sessionCookieFor } from '@/lib/admin-auth';
import { adminPageDocument, renderUnauthorizedBody } from '../admin-html';
import { HTML_HEADERS, redirectToAdmin } from '../guard';

/**
 * 管理后台登录（issue #12）：POST /admin/login（登录表单提交）。
 * 令牌匹配 ADMIN_TOKEN 时下发 HttpOnly 会话 Cookie（7 天）并 303 回 /admin；
 * 未配置令牌或匹配失败返回 401 引导页（匹配失败时提示重试）。
 */

// 每次提交都校验令牌并下发会话，禁止静态优化与缓存。
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const token = String(form.get('token') ?? '');
  const expected = configuredAdminToken();

  if (!expected || !adminTokenEquals(token, expected)) {
    return new Response(
      adminPageDocument(
        renderUnauthorizedBody({
          tokenConfigured: expected !== null,
          mismatch: true,
        }),
      ),
      { status: 401, headers: HTML_HEADERS },
    );
  }

  return redirectToAdmin('', { 'set-cookie': sessionCookieFor(expected) });
}
