import { setSourceEnabled } from '@/db/repo/sources';
import { adminGuard, redirectToAdmin } from '../guard';

/**
 * 源启用 / 停用（issue #12 源管理）：POST /admin/sources（看板每行的开关表单）。
 * 停用后抓取任务整轮跳过该源（worker/jobs/crawl-notices.ts）。
 */

// 每次提交都实时写库，禁止静态优化与缓存。
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const denied = adminGuard(request, url);
  if (denied) return denied;

  const form = await request.formData();
  const id = String(form.get('id') ?? '').trim();
  const action = String(form.get('action') ?? '').trim();
  if (!id) {
    return redirectToAdmin('error=source_not_found');
  }
  if (action !== 'enable' && action !== 'disable') {
    return new Response('未知的源操作', {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const updated = await setSourceEnabled(id, action === 'enable');
  return updated
    ? redirectToAdmin('ok=source_updated')
    : redirectToAdmin('error=source_not_found');
}
