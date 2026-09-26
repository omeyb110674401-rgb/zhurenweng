import { listNoticesFiltered } from '@/db/repo/notices';
import { getSourceById } from '@/db/repo/sources';
import { FEED_MAX_ITEMS, buildFeedXml } from '@/lib/feed';
import { siteUrl } from '@/lib/site-url';
import { describeHomeQuery, parseHomeQuery, subFeedHref, type HomeSearchParams } from '@/app/_lib/home-query';

/**
 * RSS 2.0 feed 端点（issue #6 建立，issue #63 起支持子 feed）：
 * `GET /feed.xml`，或 `GET /feed.xml?category=…&source=…&open=1&since=7`（与首页同一套筛选参数）。
 *
 * 内容随抓取管线实时更新，每次请求实时读库并按发布日期倒序生成
 * （上限 FEED_MAX_ITEMS 条），禁止静态预渲染与缓存。
 * 绝对地址取 SITE_URL（见 lib/site-url.ts，与 robots / sitemap / canonical 同一口径）。
 *
 * 参数口径**复用首页那份解析**（`parseHomeQuery`）：同一条件在页面上看到多少条、
 * 订到的就是那一批，两处的 WHERE 由 `filterConditions` 保证一致。
 * 刻意**不吃 `sort` 与 `page`**：RSS 阅读器按 `pubDate` 自己排，feed 也没有分页概念，
 * 挂上不生效的参数就是假旋钮。feed 的顺序因此固定为发布日期倒序（`sort: 'published'`），
 * 与首页默认档（倒计时序）不同 —— 这一点由子 feed 的描述文字交代（见 lib/feed.ts）。
 */

export const dynamic = 'force-dynamic';

/** 只从 querystring 里取首页筛选认的那些键（`sort` / `page` 到此为止，不进解析）。 */
function feedSearchParams(url: URL): HomeSearchParams {
  const params = new URLSearchParams(url.search);
  const pick = (name: string): string | undefined => params.get(name) ?? undefined;
  return {
    category: pick('category'),
    audience: pick('audience'),
    agency: pick('agency'),
    q: pick('q'),
    lead: pick('lead'),
    month: pick('month'),
    from: pick('from'),
    to: pick('to'),
    period: pick('period'),
    source: pick('source'),
    open: pick('open'),
    since: pick('since'),
  };
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = parseHomeQuery(feedSearchParams(url));
  const notices = await listNoticesFiltered({
    category: query.category,
    // 受众面（issue #83）：feed 与页面共用同一份解析，所以「只订这一批」的地址
    // 带 ?audience= 时订到的就是页面上那一批（subFeedHref 也把这一维写进地址）
    audience: query.audience,
    agency: query.agency,
    keyword: query.keyword,
    sourceId: query.source,
    leadAgencyOnly: query.leadAgencyOnly && query.agency !== undefined,
    publishedFromMonth: query.from,
    publishedToMonth: query.to,
    periodBucket: query.period,
    openOnly: query.openOnly,
    firstSeenWithinDays: query.sinceDays,
    sort: 'published',
    limit: FEED_MAX_ITEMS,
  });
  const base = siteUrl();
  // 条件为空串时是全量 feed：标题不带后缀、self 指回 /feed.xml 本身
  // 来源显示名字而不是 ID（与首页那行口径说明同源，`describeHomeQuery` 只少了查表这一步）
  const sourceRecord = query.source === undefined ? null : await getSourceById(query.source);
  const label = query.hasFilter ? describeHomeQuery(query, sourceRecord?.name) : undefined;
  const xml = buildFeedXml({
    siteUrl: base,
    notices,
    now: new Date(),
    filterLabel: label,
    selfUrl: label === undefined ? undefined : `${base}${subFeedHref(query)}`,
  });
  return new Response(xml, {
    status: 200,
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
