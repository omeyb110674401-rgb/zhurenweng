import Link from 'next/link';
import type { Metadata } from 'next';
import { SiteFooter } from '@/app/_lib/site-footer';

/**
 * 订阅确认结果页（issue #7）：由 /subscribe/confirm 的 303 重定向进入，
 * 经查询参数 state 区分成功 / 链接无效 / 已退订三种结果。
 */

/** 事务结果页，不进索引（issue #38）。 */
export const metadata: Metadata = { robots: { index: false, follow: true } };

export const dynamic = 'force-dynamic';

interface SubscribeConfirmedPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SubscribeConfirmedPage({ searchParams }: SubscribeConfirmedPageProps) {
  const params = await searchParams;
  const state = Array.isArray(params.state) ? params.state[0] : params.state;

  const title = state === 'invalid' ? '确认链接无效' : state === 'unsubscribed' ? '订阅已退订' : '订阅已确认';
  const detail =
    state === 'invalid'
      ? '确认链接不存在或已失效（重新提交订阅会生成新链接）。请回到订阅页重新提交，获取新的确认邮件。'
      : state === 'unsubscribed'
        ? '该邮箱此前已一键退订，确认链接随之失效；如需继续接收提醒，请回到订阅页重新提交订阅。'
        : '订阅已生效：之后每当你订阅的关键词 / 领域有新的征求意见公示，我们会在截止前 7 天、3 天各发送一封提醒邮件。每封邮件底部都有退订入口（邮件客户端的「退订」按钮可直接退订）。';

  return (
    <main id="main-content">
      <header className="site-header">
        <h1 className="brand" data-testid="subscribe-confirmed-title">
          {title}
        </h1>
        <p className="tagline">主人翁 · 公示截止提醒</p>
      </header>

      <section className="result-card" data-testid="subscribe-confirmed-detail">
        <p>{detail}</p>
        <p>
          <Link href="/subscribe">← 返回订阅页</Link> · <Link href="/">浏览最新公示</Link>
        </p>
      </section>

      <SiteFooter />
    </main>
  );
}
