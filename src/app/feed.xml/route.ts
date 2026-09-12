import { listNoticesByPublishedDesc } from '@/db/repo/notices';
import { FEED_MAX_ITEMS, buildFeedXml } from '@/lib/feed';

/**
 * 全量 RSS 2.0 feed 端点（issue #6）：GET /feed.xml
 *
 * 内容随抓取管线实时更新，每次请求实时读库并按发布日期倒序生成
 * （上限 FEED_MAX_ITEMS 条），禁止静态预渲染与缓存。
 */

export const dynamic = 'force-dynamic';

/**
 * 站点对外绝对地址（RSS link / atom:link self 用）：生产绑定域名后设置
 * SITE_URL。它与 APP_BASE_URL（订阅邮件内链接的站点地址，issue #7）各司其职：
 * 前者面向 RSS 阅读器的订阅者，后者面向邮件接收者，部署形态不同可分别配置。
 */
function siteUrl(): string {
  return (process.env.SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}

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
