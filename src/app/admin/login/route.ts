import { adminTokenEquals, configuredAdminToken, sessionCookieFor } from '@/lib/admin-auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { rateLimitedLoginResponse, redirectToAdmin, unauthorizedWithMismatch } from '../guard';

/**
 * 管理后台登录（issue #12）：POST /admin/login（登录表单提交）。
 * 令牌匹配 ADMIN_TOKEN 时下发 HttpOnly 会话 Cookie（7 天）并 303 回 /admin；
 * 未配置令牌或匹配失败返回 401 引导页（匹配失败时提示重试）。
 *
 * 登录限流（issue #52）：此前**零限流、零锁定、失败无信号** —— 共享密钥可以无限次
 * 在线爆破，而模板里的 ADMIN_TOKEN 默认值是公开占位串。按客户端 IP 计（固定窗口，
 * 阈值 ADMIN_LOGIN_RATE_LIMIT_PER_HOUR，缺省 30），超限回 429 并明说「太频繁」。
 */

// 每次提交都校验令牌并下发会话，禁止静态优化与缓存。
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  // 限流先于一切：连 formData() 都不必读（省得给爆破者任何解析成本信号）
  if (!checkRateLimit('adminLogin', request).allowed) {
    return rateLimitedLoginResponse();
  }

  // 非表单请求体（扫描器探测、content-type 错配）会让 formData() 抛错 → 500（issue #51）。
  // 登录页是公开可达的：按「令牌不对」处理，返回同一张 401 引导页即可，不必暴露 500。
  const form = await request.formData().catch(() => null);
  if (form === null) {
    return unauthorizedWithMismatch();
  }
  const token = String(form.get('token') ?? '');
  const expected = configuredAdminToken();

  if (!expected || !adminTokenEquals(token, expected)) {
    return unauthorizedWithMismatch();
  }

  return redirectToAdmin('', { 'set-cookie': sessionCookieFor(expected) });
}
