import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getNoticeById } from '@/db/repo/notices';
import { getSourceById } from '@/db/repo/sources';
import { Countdown, StatusBadge, formatDate } from '@/app/_lib/notice-display';

// 详情数据随抓取管线更新，服务端实时渲染。
export const dynamic = 'force-dynamic';

interface NoticeDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function NoticeDetailPage({ params }: NoticeDetailPageProps) {
  const { id } = await params;
  const notice = await getNoticeById(id);
  if (!notice) {
    notFound();
  }
  const source = await getSourceById(notice.sourceId);

  return (
    <main>
      <nav className="breadcrumb">
        <Link href="/">← 返回公示列表</Link>
      </nav>

      <article className="notice-detail">
        <header className="detail-header">
          <div className="detail-badges">
            <StatusBadge status={notice.status} />
            <Countdown notice={notice} now={new Date()} />
          </div>
          <h1 className="detail-title">{notice.title}</h1>
          <dl className="detail-fields" data-testid="notice-fields">
            <div className="field">
              <dt>发布机关</dt>
              <dd>{notice.agency}</dd>
            </div>
            <div className="field">
              <dt>信息来源</dt>
              <dd>{source?.name ?? notice.sourceId}</dd>
            </div>
            <div className="field">
              <dt>发布日期</dt>
              <dd>{formatDate(notice.publishedAt)}</dd>
            </div>
            <div className="field">
              <dt>截止日期</dt>
              <dd>{formatDate(notice.deadlineAt)}</dd>
            </div>
          </dl>
        </header>

        <section className="summary-slot" data-testid="summary-placeholder">
          <div className="summary-head">
            <span className="summary-tag">AI 摘要</span>
            <span className="summary-pending">摘要生成中</span>
          </div>
          <p className="summary-note">
            本站正在为本条公示生成结构化 AI 摘要（这是什么 / 影响谁 / 关键条款 / 如何提意见）。
            AI 生成内容将显著标注并附原文引用，仅供参考，以官方原文为准。
          </p>
        </section>

        <section className="action-slot">
          <a
            className="go-button"
            href={`/go/${notice.id}`}
            data-testid="go-official-button"
          >
            去官方渠道提意见
          </a>
          <div className="how-to" data-testid="how-to-comment">
            <p className="how-to-title">分步提意指引</p>
            <ol>
              <li>
                点击上方「去官方渠道提意见」按钮，跳转到
                <a href={`/go/${notice.id}`}>官方原文页面</a>
                （本站只引流，不代替官方受理意见）。
              </li>
              <li>在官方页面阅读公告全文，确认征求意见的截止日期与受理范围。</li>
              <li>按官方页面指引提交意见：通常可通过在线表单、电子邮件或信函提出，建议附上具体条款与修改建议。</li>
              <li>截止日期前提交的意见才会被纳入汇总，请留意页面上的截止时间。</li>
            </ol>
          </div>
          <p className="click-stats" data-testid="outbound-clicks">
            出站提意点击：{notice.outboundClicks} 次
          </p>
        </section>

        {notice.attachments.length > 0 ? (
          <section className="attachments">
            <h2>附件清单</h2>
            <ul data-testid="notice-attachments">
              {notice.attachments.map((attachment) => (
                <li key={attachment.url}>
                  <a href={attachment.url} target="_blank" rel="noopener noreferrer">
                    {attachment.name}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {notice.bodyText ? (
          <section className="notice-body">
            <h2>正文（纯文本，摘自官方页面）</h2>
            <div className="body-text" data-testid="notice-body">
              {notice.bodyText}
            </div>
            <p className="body-source">
              官方原文：
              <a
                href={notice.url}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="official-url"
              >
                {notice.url}
              </a>
            </p>
          </section>
        ) : null}
      </article>

      <footer className="site-footer">
        <p>
          本站只聚合官方公开信息，提交意见请一律前往官方渠道；意见的法律效力以官方渠道为准。
        </p>
      </footer>
    </main>
  );
}
