import Link from 'next/link';
import type { Metadata } from 'next';
import { unsubscribeTokenStatus } from '@/db/repo/subscriptions';

/**
 * 退订确认页（issue #34）：GET /unsubscribe?token=…
 *
 * **本页只读**：打开它不会退订。真正的退订由页面上的按钮 POST 到
 * `/unsubscribe/one-click?token=…` 完成。
 *
 * 为什么必须这么改：此前 `GET /unsubscribe?token=…` 直接写库退订，而这个链接就印在
 * 邮件正文里 —— 邮件安全网关与企业邮件系统（Outlook Safe Links、各类 ATP / 沙箱）
 * 会**预取邮件里的链接**来扫描，于是用户在完全不知情的情况下被退订，且没有任何提示；
 * 确认邮件里的退订链接同理。用户真正的点击与机器预取在 GET 上无法区分，所以把
 * 「有副作用的动作」放到 POST 上（预取器不会 POST）。
 *
 * 顺带这也让「一键退订」符合 RFC 8058：邮件头带上 `List-Unsubscribe` 与
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` 后，邮件客户端自己的
 * 「退订」按钮会 POST 到同一地址，立即生效（见 lib/mail.ts）。
 */

/**
 * 不进索引（issue #38）：地址里带退订 token，一旦被收录，任何人都能拿索引里的
 * URL 退掉别人的订阅。noindex + nofollow（这里没有需要爬虫跟随的链接）。
 */
export const metadata: Metadata = { robots: { index: false, follow: false } };

// token 状态随退订实时变化，禁止静态预渲染。
export const dynamic = 'force-dynamic';

interface UnsubscribePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function UnsubscribePage({ searchParams }: UnsubscribePageProps) {
  const params = await searchParams;
  const token = (Array.isArray(params.token) ? params.token[0] : params.token)?.trim() ?? '';
  const status = await unsubscribeTokenStatus(token);

  return (
    <main>
      <header className="site-header">
        <h1 className="brand" data-testid="unsubscribe-title">
          {status === 'confirmable' ? '确认退订' : status === 'unsubscribed' ? '已退订' : '退订链接无效'}
        </h1>
        <p className="tagline">主人翁 · 公示截止提醒</p>
      </header>

      {status === 'confirmable' ? (
        <section className="result-card" data-testid="unsubscribe-confirm">
          <p>点击下面的按钮即可退订：退订后不会再收到任何来自「主人翁」的提醒邮件，且立即生效。</p>
          {/* POST 才写库：邮件网关预取本页（GET）不会造成退订 */}
          <form action="/unsubscribe/one-click" method="post">
            <input type="hidden" name="token" value={token} />
            <button className="filter-button" type="submit" data-testid="unsubscribe-submit">
              确认退订
            </button>
          </form>
          <p>
            <Link href="/subscribe">查看订阅设置</Link> · <Link href="/">浏览最新公示</Link>
          </p>
        </section>
      ) : (
        <section className="result-card" data-testid="unsubscribe-status">
          <p>
            {status === 'unsubscribed'
              ? '该邮箱已经退订过了，无需重复操作。如果改变主意，随时可以重新订阅。'
              : '未找到对应的订阅（链接可能不完整）。请使用邮件底部的完整退订链接，或重新提交订阅。'}
          </p>
          <p>
            <Link href="/subscribe">重新订阅</Link> · <Link href="/">浏览最新公示</Link>
          </p>
        </section>
      )}

      <footer className="site-footer">
        <p>提交意见请一律前往官方渠道；本站只聚合官方公开信息并提供解读与提醒。</p>
      </footer>
    </main>
  );
}
