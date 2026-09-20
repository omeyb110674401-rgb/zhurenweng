import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { siteUrl } from '@/lib/site-url';
import './globals.css';

// metadataBase：canonical 与分享链接需要绝对地址（生产由 compose 注入 SITE_URL）
const base = siteUrl();

export const metadata: Metadata = {
  metadataBase: new URL(base),
  title: '主人翁 —— 政府公示与征求意见信息聚合',
  description:
    '聚合国家级政府公示与征求意见稿，用 AI 摘要帮你发现、读懂、参与：发现 · 读懂 · 行动。',
  // 分享元数据（条目详情页各自覆盖 title / description / og:url）
  openGraph: {
    type: 'website',
    siteName: '主人翁',
    locale: 'zh_CN',
    url: base,
  },
  // RSS 自动发现（issue #6）：阅读器可从页面 head 识别全量 feed
  alternates: {
    types: {
      'application/rss+xml': '/feed.xml',
    },
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="page">{children}</div>
      </body>
    </html>
  );
}
