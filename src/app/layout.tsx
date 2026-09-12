import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: '主人翁 —— 政府公示与征求意见信息聚合',
  description:
    '聚合国家级政府公示与征求意见稿，用 AI 摘要帮你发现、读懂、参与：发现 · 读懂 · 行动。',
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
