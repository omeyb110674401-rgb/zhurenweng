import Link from 'next/link';
import { listNotices } from '@/db/repo/notices';
import type { NoticeRecord } from '@/db/types';
import { Countdown, StatusBadge, formatDate } from '@/app/_lib/notice-display';

// 数据随抓取管线持续更新，首页始终服务端实时渲染，不做静态预渲染。
export const dynamic = 'force-dynamic';

function NoticeItem({ notice }: { notice: NoticeRecord }) {
  return (
    <li className="notice-item" data-testid="notice-item">
      <div className="notice-item-head">
        <StatusBadge status={notice.status} />
        <Countdown notice={notice} now={new Date()} />
      </div>
      <Link className="notice-title" href={`/notices/${notice.id}`} data-testid="notice-title-link">
        {notice.title}
      </Link>
      <div className="notice-meta">
        {notice.agency} · 发布：{formatDate(notice.publishedAt)} · 截止：
        {formatDate(notice.deadlineAt)}
      </div>
    </li>
  );
}

export default async function HomePage() {
  // 仓库层排序：征求意见中在前、截止日期升序（即将截止在前）、无截止日期靠后
  const notices = await listNotices({ limit: 50 });

  return (
    <main>
      <header className="site-header">
        <h1 className="brand">
          主人<span className="brand-accent">翁</span>
        </h1>
        <p className="tagline">政府公示与征求意见信息聚合 —— 发现 · 读懂 · 行动</p>
      </header>

      <section className="notice-section" aria-labelledby="notice-list-title">
        <h2 id="notice-list-title">最新公示</h2>
        <p className="section-hint">
          按征求意见截止日期排序，即将截止的排在最前。
          {/* RSS 订阅入口（issue #6）：页面可见入口，配合 head 内的自动发现链接 */}
          <a className="rss-link" href="/feed.xml" data-testid="rss-feed-link">
            RSS 订阅
          </a>
        </p>
        {notices.length === 0 ? (
          <div className="empty-state" data-testid="notice-empty-state">
            <p className="empty-title">暂无公示条目</p>
            <p className="empty-hint">
              数据管线尚未收录任何官方公示。抓取管线接入后，这里将按截止日期倒计时展示全国人大、
              各部委等渠道的最新征求意见稿。
            </p>
          </div>
        ) : (
          <ul className="notice-list">
            {notices.map((notice) => (
              <NoticeItem key={notice.id} notice={notice} />
            ))}
          </ul>
        )}
      </section>

      <footer className="site-footer">
        <p>
          本站只聚合官方公开信息并提供 AI 解读（AI 生成内容将显著标注），提交意见请一律前往官方渠道。
        </p>
        <p>ICP 备案：待备案（占位）</p>
      </footer>
    </main>
  );
}
