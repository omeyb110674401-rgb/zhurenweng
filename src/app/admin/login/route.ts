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
  // 非表单请求体（扫描器探测、content-type 错配）会让 formData() 抛错 → 500（issue #51）。
  // 登录页是公开可达的：按「令牌不对」处理，返回同一张 401 引导页即可，不必暴露 500。
  const form = await request.formData().catch(() => null);
  if (form === null) {
    return new Response(
      adminPageDocument(
        renderUnauthorizedBody({ tokenConfigured: configuredAdminToken() !== null, mismatch: true }),
      ),
      { status: 401, headers: HTML_HEADERS },
    );
  }
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
