import { listNoticesByPublishedDesc } from '@/db/repo/notices';
import { FEED_MAX_ITEMS, buildFeedXml } from '@/lib/feed';
import { siteUrl } from '@/lib/site-url';

/**
 * 全量 RSS 2.0 feed 端点（issue #6）：GET /feed.xml
 *
 * 内容随抓取管线实时更新，每次请求实时读库并按发布日期倒序生成
 * （上限 FEED_MAX_ITEMS 条），禁止静态预渲染与缓存。
 * 绝对地址取 SITE_URL（见 lib/site-url.ts，与 robots / sitemap / canonical 同一口径）。
 */

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const notices = await listNoticesByPublishedDesc({ limit: FEED_MAX_ITEMS });
  const xml = buildFeedXml({ siteUrl: siteUrl(), notices, now: new Date() });
  return new Response(xml, {
    status: 200,
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
