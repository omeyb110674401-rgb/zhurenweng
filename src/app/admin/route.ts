import { listSources } from '@/db/repo/sources';
import { listNoticesForReview } from '@/db/repo/summaries';
import { configuredAdminToken, isAuthorizedAdminRequest } from '@/lib/admin-auth';
import { adminPageDocument, renderDashboardBody, renderUnauthorizedBody } from './admin-html';
import { HTML_HEADERS } from './guard';

/**
 * 管理后台主页（issue #12）：源健康看板 + 摘要人工复核队列 + 手动补录表单。
 *
 * 访问保护：ADMIN_TOKEN 环境变量 —— 未配置时所有请求返回 401 配置指引页；
 * 已配置时凭会话 Cookie（POST /admin/login 下发）或 `?token=` 查询参数放行，
 * 匹配失败同样 401。用最简方式实现（无任何认证依赖），详见 src/lib/admin-auth.ts。
 */

// 看板与队列随抓取 / 摘要管线实时变化，服务端实时渲染。
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (!isAuthorizedAdminRequest(request, url)) {
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

  const [sources, reviewItems] = await Promise.all([listSources(), listNoticesForReview()]);
  return new Response(
    renderDashboardBody({
      flashOk: url.searchParams.get('ok'),
      flashError: url.searchParams.get('error'),
      sources,
      reviewItems,
    }),
    { status: 200, headers: HTML_HEADERS },
  );
}
