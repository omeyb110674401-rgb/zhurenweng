import type { MetadataRoute } from 'next';
import { listAllNoticesForReindex } from '@/db/repo/notices';
import { siteUrl } from '@/lib/site-url';

/**
 * sitemap.xml（可发现性）：公示列表 + 统计页 + 全部条目详情。
 *
 * - 不收录 `/go/<id>`（302 跳转端点，不是内容页）；
 * - 已截止条目同样收录 —— 它们是有效的公示存档页，正文与截止日期仍有查阅价值；
 * - 站点对外地址与条目集合都在请求时读取（生产由 compose 注入 SITE_URL），
 *   收录量级为每月数十条，全量取一次即可。
 */
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const notices = await listAllNoticesForReindex();

  return [
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
      lastModified: notice.fetchedAt,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    })),
  ];
}
