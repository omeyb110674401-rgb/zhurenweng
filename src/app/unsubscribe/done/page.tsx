import Link from 'next/link';

/**
 * 退订结果页（issue #7）：由 /unsubscribe 的 303 重定向进入，
 * ok=0 表示退订链接无效，其余展示退订成功。
 */

export const dynamic = 'force-dynamic';

interface UnsubscribeDonePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function UnsubscribeDonePage({ searchParams }: UnsubscribeDonePageProps) {
  const params = await searchParams;
  const ok = (Array.isArray(params.ok) ? params.ok[0] : params.ok) !== '0';

  const title = ok ? '已退订' : '退订链接无效';
  const detail = ok
    ? '退订已立即生效，之后不会再收到任何来自「主人翁」的邮件。如果改变主意，随时可以重新订阅。'
    : '未找到对应的订阅（链接可能不完整）。请使用邮件底部的完整退订链接，或重新提交订阅。';

  return (
    <main>
      <header className="site-header">
        <h1 className="brand" data-testid="unsubscribe-result-title">
          {title}
        </h1>
        <p className="tagline">主人翁 · 公示截止提醒</p>
      </header>

      <section className="result-card" data-testid="unsubscribe-result-detail">
        <p>{detail}</p>
        <p>
          <Link href="/subscribe">重新订阅</Link> · <Link href="/">浏览最新公示</Link>
        </p>
      </section>

      <footer className="site-footer">
        <p>提交意见请一律前往官方渠道；本站只聚合官方公开信息并提供解读与提醒。</p>
      </footer>
    </main>
  );
}
