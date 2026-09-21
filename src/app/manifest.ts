import type { MetadataRoute } from 'next';

/**
 * Web App Manifest（issue #53）：此前没有 manifest，「添加到主屏」在安卓上得到
 * 一个没有名称、没有主题色的裸快捷方式。
 *
 * 图标指向 icon.svg（`sizes: any` + `purpose: any`）：安卓 Chrome 支持 SVG 图标，
 * 且这个文件与 apple-icon 的几何形状一致，跨平台观感统一。theme_color 与
 * `layout.tsx` 的 viewport.themeColor 取同一个值（#b45309）。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: '主人翁 —— 政府公示与征求意见信息聚合',
    short_name: '主人翁',
    description: '聚合国家级政府公示与征求意见稿，用 AI 摘要帮你发现、读懂、参与。',
    start_url: '/',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: '#b45309',
    lang: 'zh-CN',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  };
}
