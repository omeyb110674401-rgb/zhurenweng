import { configuredAdminToken, isAuthorizedAdminRequest } from '@/lib/admin-auth';
import { adminPageDocument, renderUnauthorizedBody } from './admin-html';

/**
 * /admin 路由的共享守卫与小工具（issue #12）。
 * 本文件是 app 目录下的普通模块（非路由文件），只被 admin 路由引用。
 */

export const HTML_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
};

/**
 * 写操作与页面的统一守卫：已授权返回 null；未授权返回 401 引导页。
 * POST 端点同样接受 `?token=` 查询参数，便于脚本调用。
 */
export function adminGuard(request: Request, url: URL): Response | null {
  if (isAuthorizedAdminRequest(request, url)) return null;
  return new Response(
    adminPageDocument(
      renderUnauthorizedBody({
        tokenConfigured: configuredAdminToken() !== null,
        mismatch: false,
      }),
    ),
    { status: 401, headers: HTML_HEADERS },
  );
}

/**
 * 303 重定向（相对 Location）：与 /api/subscriptions 相同的约定 ——
 * 自定义服务器 / 反代场景下 request.url 的 origin 不可靠，相对路径由
 * 客户端按当前地址解析。
 */
export function redirectToAdmin(query: string, extraHeaders: Record<string, string> = {}): Response {
  const location = query ? `/admin?${query}` : '/admin';
  return new Response(null, { status: 303, headers: { location, ...extraHeaders } });
}
