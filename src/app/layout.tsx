import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { siteUrl } from '@/lib/site-url';
import { llmReady } from '@/lib/llm-availability';
import { OG_IMAGE } from '@/lib/page-metadata';
import './globals.css';

// metadataBase：canonical 与分享链接需要绝对地址（生产由 compose 注入 SITE_URL）
const base = siteUrl();

/**
 * 站点描述的两个版本（issue #54）：AI 那版只在端口真的可用时才说。
 *
 * 与 `siteUrl()` 一样在模块作用域求值 —— 换配置需要重启容器，届时本行会重新执行，
 * 所以取到的一定是进程实际生效的那份环境（详情页的 AI 摘要门控同理）。
 */
const SITE_DESCRIPTION = llmReady()
  ? '聚合国家级政府公示与征求意见稿，用 AI 摘要帮你发现、读懂、参与：发现 · 读懂 · 行动。'
  : '聚合国家级政府公示与征求意见稿：按征求意见截止日期倒计时排列，速读与提交方式逐字摘自官方原文，并给出官方提交入口。';

/**
 * 移动端浏览器界面色（issue #53）：地址栏/状态栏跟随品牌琥珀色，与
 * `manifest.ts` 的 theme_color 取同一个值（两处不一致时安卓会取 manifest 的）。
 */
export const viewport: Viewport = {
  themeColor: '#b45309',
};

export const metadata: Metadata = {
  metadataBase: new URL(base),
  title: '主人翁 —— 政府公示与征求意见信息聚合',
  // 描述按 `llmReady()` 取版本（issue #54）：这句是搜索引擎结果里对本站的**对外承诺**，
  // 而详情页的 AI 摘要区块由同一个门控决定显不显示。线上出现过描述写着「用 AI 摘要」、
  // 实际抽样 20/20 的条目都显示「AI 结构化解读尚未启用」的错配。未启用时改为陈述
  // 站点真实在做的事（官方原文聚合 + 程序摘录 + 截止日期倒计时）。
  description: SITE_DESCRIPTION,
  // 分享元数据（条目详情页各自覆盖 title / description / og:url）
  openGraph: {
    type: 'website',
    siteName: '主人翁',
    locale: 'zh_CN',
    url: base,
    // 分享图（issue #53）：静态文件 + 显式声明，见 lib/page-metadata.ts 的说明。
    // 页面自己导出 openGraph 时也要带上它（simplePageMetadata 已包含）。
    images: [OG_IMAGE],
  },
  // 分享卡片（issue #53）：配图由同目录的 opengraph-image.png 自动注入 og:image，
  // 这里只声明大图卡片形态（此前是 summary，缩略图小、辨识度低）
  twitter: { card: 'summary_large_image' },
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
        {/* 跳转主内容（issue #53）：body 的第一个可聚焦元素，键盘用户按一次 Tab
            即可跳过搜索框、站内导航与领域筛选，直达 id="main-content" 的 <main> */}
        <a className="skip-link" href="#main-content">
          跳到主要内容
        </a>
        <div className="page">{children}</div>
      </body>
    </html>
  );
}
