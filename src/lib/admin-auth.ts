import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * 管理后台访问保护（issue #12）—— 最小实现，不引入任何认证依赖。
 *
 * 模型：共享密钥 ADMIN_TOKEN（环境变量）。
 * - 未配置 ADMIN_TOKEN：所有 /admin* 请求一律 401 引导页（提示如何配置）；
 * - 匹配：登录表单（POST /admin/login）提交 token，正确则下发 HttpOnly 会话
 *   Cookie（值即共享密钥，有效期 7 天）；
 * - `?token=` 查询参数**不再直接授权请求**（issue #52）：它只在 GET 上做一次
 *   「换取会话 Cookie + 303 到去掉 token 的同地址」，换取动作在 admin/guard.ts。
 *   从前每个请求都接受 `?token=`，于是共享密钥会留在浏览器历史 / 书签 / 分享出去的
 *   链接里 —— 而它没有独立的吊销手段（改了 ADMIN_TOKEN 才能作废）。脚本用法见 README。
 * - 比较采用常量时间（双方各做 SHA-256 后 timingSafeEqual，规避长度泄漏）。
 *
 * Cookie 为 SameSite=Lax，可阻绝跨站表单携带会话发起的 POST；后台所有写操作
 * 仅站长本人使用，与既有端点（如订阅提交）一致地不另做 CSRF token。
 * `Secure` 见 sessionCookieFor 的注释。
 */

export const ADMIN_SESSION_COOKIE = 'zw_admin_session';

/** 会话有效期（秒）：7 天，过期后重新登录 */
export const ADMIN_SESSION_MAX_AGE = 7 * 24 * 60 * 60;

/** 读取配置的共享密钥；未配置（空 / 纯空白）返回 null。 */
export function configuredAdminToken(): string | null {
  const token = process.env.ADMIN_TOKEN?.trim();
  return token ? token : null;
}

/** 常量时间字符串比较：定长摘要后按字节比较。 */
export function adminTokenEquals(candidate: string, expected: string): boolean {
  const left = createHash('sha256').update(candidate).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

/** 解析 Cookie 请求头为键值表（值按 encodeURIComponent 编码存储）。 */
export function parseCookies(cookieHeader: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader?.split(';') ?? []) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

/**
 * 请求是否已授权：**只看会话 Cookie**（`?token=` 的换取动作在 admin/guard.ts）。
 * 未配置 ADMIN_TOKEN 时恒为 false。
 */
export function isAuthorizedAdminRequest(request: Request): boolean {
  const expected = configuredAdminToken();
  if (!expected) return false;
  const cookieToken = parseCookies(request.headers.get('cookie'))[ADMIN_SESSION_COOKIE];
  return cookieToken !== undefined && adminTokenEquals(cookieToken, expected);
}

/**
 * 登录成功下发的会话 Cookie（值即共享密钥，最小权限路径 /）。
 *
 * `Secure`（issue #52）：Cookie 的值就是后台的长期凭据，而没有 HSTS 时浏览器
 * 在 `http://` 首跳会**先把 Cookie 发出去**（Caddy 的 301 发生在之后）—— 在途
 * 攻击者拿到它就等于拿到全部后台写权限。localhost 属浏览器定义的安全上下文，
 * 本地开发与 E2E（手工回放 Cookie 头）都不受影响。
 */
export function sessionCookieFor(token: string): string {
  return [
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${ADMIN_SESSION_MAX_AGE}`,
  ].join('; ');
}

/** 退出登录：下发即刻过期的空 Cookie（属性与下发时一致，浏览器才认得出是同一个）。 */
export function clearedSessionCookie(): string {
  return `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
