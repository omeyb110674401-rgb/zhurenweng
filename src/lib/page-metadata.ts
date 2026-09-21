import type { Metadata } from 'next';
import { siteUrl } from '@/lib/site-url';

/**
 * 分享图（issue #53）：1200×630 的静态 PNG，由 `scripts/gen-brand-assets.mjs` 生成。
 *
 * 为什么不用 Next 的 `opengraph-image.tsx` 文件约定：**文件约定的图会被页面自己的
 * `openGraph` 整块覆盖** —— 只要页面（或它的 generateMetadata）导出了 openGraph，
 * og:image 就没了。实测统计页与详情页都因此完全没有分享图（e2e 的
 * brand-assets 场景当场抓到）。改成静态文件 + 显式声明后，谁覆盖都不会丢，
 * 构建期也不必再执行一次 satori/resvg 光栅化。
 */
export const OG_IMAGE = {
  url: '/og-image.png',
  width: 1200,
  height: 630,
  alt: '主人翁 —— 政府公示与征求意见信息聚合',
};

/**
 * 页面级元数据（issue #53）：标题 + 描述 + 分享信息一次写全。
 *
 * 为什么需要这个辅助函数：Next 的 metadata 合并是**整块覆盖** —— 子路由一旦导出
 * `openGraph`，父级 layout 里的 siteName / locale / type 就全丢了（与 `alternates`
 * 是同一个陷阱，issue #41 在首页踩过）。所以每个自定义分享信息的页面都得把这
 * 几项重复一遍；与其在三处各写一份、哪天漏掉一处，不如收在这里。
 *
 * `og:image` 不在其中：它来自 `src/app/opengraph-image.png` 这个文件约定，
 * 由 Next 在合并之后注入，页面无需（也无法）重复声明。
 *
 * 标题统一补「—— 主人翁」后缀，与详情页、对比页的既有写法一致。
 */
export function simplePageMetadata({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  path: string;
}): Metadata {
  const fullTitle = `${title} —— 主人翁`;
  return {
    title: fullTitle,
    description,
    openGraph: {
      type: 'website',
      siteName: '主人翁',
      locale: 'zh_CN',
      title: fullTitle,
      description,
      url: `${siteUrl()}${path}`,
      images: [OG_IMAGE],
    },
  };
}
