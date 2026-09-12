import { clearedSessionCookie } from '@/lib/admin-auth';
import { redirectToAdmin } from '../guard';

/**
 * 管理后台退出登录（issue #12）：POST /admin/logout ——
 * 下发即刻过期的空会话 Cookie 并 303 回 /admin（回到 401 引导页）。
 */

export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  return redirectToAdmin('', { 'set-cookie': clearedSessionCookie() });
}
