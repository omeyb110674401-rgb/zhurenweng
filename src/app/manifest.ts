import type { MetadataRoute } from 'next';
import { llmReady } from '@/lib/llm-availability';

// 描述要按运行时环境取（issue #54）：本文件此前没有声明 dynamic，一旦引入 `llmReady()`
// 就会重演 not-found 的坑 —— 构建期算出的值被固化（见 src/app/not-found.tsx 的说明）。
export const dynamic = 'force-dynamic';

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
    // AI 那半句只在端口真的可用时说（issue #54），与 layout 的 description 同门控
    description: llmReady()
      ? '聚合国家级政府公示与征求意见稿，用 AI 摘要帮你发现、读懂、参与。'
      : '聚合国家级政府公示与征求意见稿，按截止日期倒计时排列，速读摘自官方原文并给出提交入口。',
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
