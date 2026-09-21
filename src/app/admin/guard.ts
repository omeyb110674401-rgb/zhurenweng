import {
  adminTokenEquals,
  configuredAdminToken,
  isAuthorizedAdminRequest,
  sessionCookieFor,
} from '@/lib/admin-auth';
import { adminPageDocument, renderUnauthorizedBody } from './admin-html';

/**
 * /admin 路由的共享守卫与小工具（issue #12）。
 * 本文件是 app 目录下的普通模块（非路由文件），只被 admin 路由引用。
 */

export const HTML_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
};

/** 引导页（未授权 / 未配置令牌 / 登录失败 / 登录限流都走这里，差别只在文案与状态码）。 */
function loginPageResponse(options: {
  mismatch?: boolean;
  rateLimited?: boolean;
  status?: number;
}): Response {
  return new Response(
    adminPageDocument(
      renderUnauthorizedBody({
        tokenConfigured: configuredAdminToken() !== null,
        mismatch: options.mismatch === true,
        rateLimited: options.rateLimited === true,
      }),
    ),
    { status: options.status ?? 401, headers: HTML_HEADERS },
  );
}

/**
 * 去掉 `token` 查询参数、保留其余参数的同地址（换取会话后跳到这里）。
 * 保留其余参数是必要的：`/admin?ok=review_saved&token=…` 换完会话要落回带横幅的看板。
 */
function locationWithoutToken(url: URL): string {
  const params = new URLSearchParams(url.searchParams);
  params.delete('token');
  const query = params.toString();
  return query.length > 0 ? `${url.pathname}?${query}` : url.pathname;
}

/**
 * 写操作与页面的统一守卫：已授权返回 null；未授权返回 401 引导页。
 *
 * `?token=` 换取会话（issue #52）：**GET** 带有效 token 时不执行原请求，只下发
 * 会话 Cookie 并 303 到去掉 token 的同地址 —— 于是共享密钥不会留在浏览器历史 /
 * 书签 / 分享出去的链接里，后续请求（含 POST）一律只看 Cookie。脚本用法见 README。
 * POST 不做换取：写操作必须已持有会话，否则一次误点的链接就能触发写动作。
 */
export function adminGuard(request: Request, url: URL): Response | null {
  if (isAuthorizedAdminRequest(request)) return null;

  if (request.method === 'GET') {
    const token = url.searchParams.get('token');
    const expected = configuredAdminToken();
    if (token && expected && adminTokenEquals(token, expected)) {
      return new Response(null, {
        status: 303,
        headers: {
          location: locationWithoutToken(url),
          'set-cookie': sessionCookieFor(token),
        },
      });
    }
  }

  return loginPageResponse({});
}

/** 登录失败页（令牌不匹配）——与未授权页同一张，只是文案提示重试。 */
export function unauthorizedWithMismatch(): Response {
  return loginPageResponse({ mismatch: true });
}

/** 登录限流页（429，issue #52）——文案与「令牌不匹配」区分开。 */
export function rateLimitedLoginResponse(): Response {
  return loginPageResponse({ rateLimited: true, status: 429 });
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
