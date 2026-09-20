import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/site-url';

/**
 * robots.txt（可发现性）：允许收录公示内容，屏蔽无索引价值的端点。
 *
 * - `/admin`：站长看板（token 保护），不该进索引；
 * - `/go/`：出站跳转端点（302 到官方原文），收录它只会给爬虫制造重定向噪音；
 * - `/api/`：提交端点（POST）。
 *
 * 站点对外地址在请求时读取（生产由 compose 注入 SITE_URL），因此不能静态预渲染。
 */
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/admin', '/go/', '/api/'],
      },
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
