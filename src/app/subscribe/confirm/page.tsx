import Link from 'next/link';
import type { Metadata } from 'next';
import { confirmTokenStatus } from '@/db/repo/subscriptions';
import { SiteFooter } from '@/app/_lib/site-footer';

/**
 * 订阅确认页（issue #7，double opt-in 第二步）：GET /subscribe/confirm?token=…
 *
 * **本页只读**：打开它不会确认订阅。真正的确认由页面上的按钮 POST 到
 * `/subscribe/confirm/submit` 完成（与退订侧 `POST /unsubscribe/one-click` 对称）。
 *
 * 为什么必须这么改（issue #52）：确认链接就印在邮件正文里，而邮件安全网关与企业
 * 邮件系统（Outlook Safe Links、各类 ATP / 沙箱）会**预取邮件里的链接**来扫描 ——
 * GET 直接写库会让订阅在邮箱主人完全不知情的情况下生效，并把那个确认链接消耗掉。
 * 用户真正的点击与机器预取在 GET 上无法区分，所以「有副作用的动作」只能放在 POST 上。
 * 退订侧早在 issue #34 就是这么改的（见 app/unsubscribe/page.tsx），确认侧当时漏了 ——
 * 同一个原则没有贯彻到底。
 */

/**
 * 不进索引（issue #38 同款理由）：地址里带确认 token，一旦被收录，任何人都能拿
 * 索引里的 URL 打开别人的确认页（虽然本页只读，仍不该被搜索引擎持有）。
 */
export const metadata: Metadata = { robots: { index: false, follow: false } };

// token 状态随确认 / 退订实时变化，禁止静态预渲染。
export const dynamic = 'force-dynamic';

interface ConfirmPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SubscribeConfirmPage({ searchParams }: ConfirmPageProps) {
  const params = await searchParams;
  const token = (Array.isArray(params.token) ? params.token[0] : params.token)?.trim() ?? '';
  const status = await confirmTokenStatus(token);

  const title =
    status === 'confirmable'
      ? '确认订阅'
      : status === 'confirmed'
        ? '订阅已确认'
        : status === 'unsubscribed'
          ? '该邮箱已退订'
          : '确认链接无效';

  return (
    <main id="main-content">
      <header className="site-header">
        <h1 className="brand" data-testid="subscribe-confirm-title">
          {title}
        </h1>
        <p className="tagline">主人翁 · 公示截止提醒</p>
      </header>

      {status === 'confirmable' ? (
        <section className="result-card" data-testid="subscribe-confirm">
          <p>
            点击下面的按钮即可完成确认：之后每当你订阅的关键词 / 领域有新的征求意见公示，
            我们会在截止前 7 天、3 天各发送一封提醒邮件。每封邮件底部都有退订入口。
          </p>
          {/* POST 才写库：邮件网关预取本页（GET）不会造成确认 */}
          <form action="/subscribe/confirm/submit" method="post">
            <input type="hidden" name="token" value={token} />
            <button className="filter-button" type="submit" data-testid="subscribe-confirm-submit">
              确认订阅
            </button>
          </form>
          <p>
            <Link href="/subscribe">查看订阅设置</Link> · <Link href="/">浏览最新公示</Link>
          </p>
        </section>
      ) : (
        <section className="result-card" data-testid="subscribe-confirm-status">
          <p>
            {status === 'confirmed'
              ? '该邮箱的订阅已经确认过了，无需重复操作。'
              : status === 'unsubscribed'
                ? '该邮箱此前已一键退订，确认链接随之失效；如需继续接收提醒，请重新提交订阅。'
                : '未找到对应的订阅（链接可能不完整或已被替换）。重新提交订阅会生成新的确认链接。'}
          </p>
          <p>
            <Link href="/subscribe">返回订阅页</Link> · <Link href="/">浏览最新公示</Link>
          </p>
        </section>
      )}

      <SiteFooter />
    </main>
  );
}
