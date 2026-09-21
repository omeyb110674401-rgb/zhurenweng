import type { MetadataRoute } from 'next';
import { listAllNoticesForReindex } from '@/db/repo/notices';
import { siteUrl } from '@/lib/site-url';

/**
 * sitemap.xml（可发现性）：公示列表 + 统计页 + 全部条目详情。
 *
 * - 不收录 `/go/<id>`（302 跳转端点，不是内容页）；
 * - 已截止条目同样收录 —— 它们是有效的公示存档页，正文与截止日期仍有查阅价值；
 * - 站点对外地址与条目集合都在请求时读取（生产由 compose 注入 SITE_URL），
 *   收录量级为每月数十条，全量取一次即可；
 * - **`lastModified` 是内容时间，不是抓取时间**（issue #44，见下）。
 */
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const notices = await listAllNoticesForReindex();

  return [
    // 列表页与统计页不写 lastModified：它们的「上次变更时间」我们并没有记录，
    // 宁可省略（省略是合法的，写错会污染信号）
    {
      url: `${base}/`,
      changeFrequency: 'daily',
      priority: 1,
    },
    {
      url: `${base}/stats`,
      changeFrequency: 'daily',
      priority: 0.5,
    },
    ...notices.map((notice) => ({
      url: `${base}/notices/${notice.id}`,
      /**
       * 内容时间，不是我们的抓取时间（issue #44）。
       *
       * 原先用 `fetchedAt`：抓取每日一轮 → 线上实测 **178/178 条 lastmod 全是当天**，
       * 而绝大多数页面的内容根本没变（官方文档发布后是静态的）。持续失真的
       * lastmod 会让搜索侧直接不再信任这个信号 —— 于是「这条真的更新了，值得
       * 重抓」也表达不出来，白白丢掉一个抓取调度信号。
       *
       * 取发布日期：文档发布即定型，这也是「这一页是什么时候变成现在这样的」的
       * 真实答案。发布日缺失时退回抓取时间（生产实测缺失 0 条），不写空值。
       */
      lastModified: notice.publishedAt ?? notice.fetchedAt,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    })),
  ];
}
