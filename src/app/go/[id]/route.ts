import { NextResponse } from 'next/server';
import { getNoticeById, recordOutboundClick } from '@/db/repo/notices';
import { localDateIso } from '@/lib/dates';

/**
 * 出站跳转端点（PRD「出站转化埋点」）：/go/<条目ID>
 *
 * 记录一次点击（条目 ID + 日期，不记录任何个人身份 —— 不存 IP、不设 Cookie），
 * 然后 302 跳转到该条目的官方原文 URL。北极星指标「出站提意点击数」据此累计，
 * 后续统计切片（M3）按条目 / 日期聚合。
 */

// 每次请求都要实时读库与计数，禁止静态优化与缓存。
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const notice = await getNoticeById(id);
  if (!notice) {
    return NextResponse.json({ error: '未找到该公示条目' }, { status: 404 });
  }

  let target: URL;
  try {
    target = new URL(notice.url);
  } catch {
    return NextResponse.json({ error: '该条目缺少有效的官方原文链接' }, { status: 500 });
  }

  const clicks = await recordOutboundClick(id);
  if (clicks === null) {
    return NextResponse.json({ error: '未找到该公示条目' }, { status: 404 });
  }

  // 非个人身份的访问日志：仅条目 ID 与日期
  console.log(
    `[go] date=${localDateIso(new Date())} noticeId=${id} outboundClicks=${clicks}`,
  );

  return NextResponse.redirect(target, 302);
}
