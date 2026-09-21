import type { ReactNode } from 'react';
import Link from 'next/link';
import { IcpFiling } from '@/app/_lib/icp-filing';
import { mailerReady } from '@/lib/mailer-availability';

/**
 * 全站页脚（issue #53）。
 *
 * 此前 12 个页面各写一份页脚，文案互不相同，而且 **ICP 备案号只有 3 个页面有**
 * （首页、搜索页、404）。备案号要在站点所有页面底部可见 —— 这是合规要求，
 * 不只是观感问题；顺带补上站内导航（此前 /stats 与 /subscribe 只能从首页互达，
 * 详情页、统计页之间没有任何互链）。
 *
 * `note` 是给少数页面保留自己那段说明用的（统计页的隐私边界、对比页的比对口径），
 * 其余页面共用下面这句合并了原有各版本要点的标准文案。
 *
 * 订阅入口与首页导航同门控（`mailerReady`）：邮件端口未配置时不渲染指向
 * `/subscribe` 的链接 —— 该页此刻只会给出「暂未开放」。这条被
 * tests/e2e/subscribe-availability.test.mjs 反向钉住（首页不得出现 href="/subscribe"）。
 */
const DEFAULT_NOTE =
  '本站只聚合官方公开信息并提供解读（AI 生成内容将显著标注）；提交意见请一律前往官方渠道，意见的法律效力以官方渠道为准。';

export function SiteFooter({ note }: { note?: ReactNode }) {
  return (
    <footer className="site-footer">
      <p>{note ?? DEFAULT_NOTE}</p>
      <nav className="footer-nav" data-testid="site-footer-nav" aria-label="页脚导航">
        <Link href="/">首页</Link>
        <Link href="/stats">数据统计</Link>
        {mailerReady() ? <Link href="/subscribe">订阅提醒</Link> : null}
        {/* RSS 是路由处理器而不是页面，用普通 <a>（Link 会去预取 RSC 载荷） */}
        <a href="/feed.xml">RSS 订阅</a>
      </nav>
      <IcpFiling />
    </footer>
  );
}
