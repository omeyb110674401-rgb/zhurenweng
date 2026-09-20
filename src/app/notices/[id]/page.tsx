import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getNoticeById } from '@/db/repo/notices';
import { getNoticeSummary } from '@/db/repo/summaries';
import { getSourceById } from '@/db/repo/sources';
import { Countdown, StatusBadge, formatDate } from '@/app/_lib/notice-display';
import { NoticeBriefView, SubmissionChannels } from '@/app/_lib/notice-brief-view';
import { SummaryPlaceholder, SummaryUnavailable, SummaryView } from '@/app/_lib/summary-view';
import { buildNoticeBrief } from '@/lib/notice-brief';
import { llmReady } from '@/lib/llm-availability';
import { mailerReady } from '@/lib/mailer-availability';
import { siteUrl } from '@/lib/site-url';
import type { NoticeRecord } from '@/db/types';

// 详情数据随抓取管线更新，服务端实时渲染。
export const dynamic = 'force-dynamic';

interface NoticeDetailPageProps {
  params: Promise<{ id: string }>;
}

/**
 * 条目的分享 / 检索摘要（可发现性）：状态 + 截止日期 + 机关 + 正文首段。
 * 搜索结果的描述片段直接影响点击率，「什么时候截止」放最前。
 */
function noticeDescription(notice: NoticeRecord): string {
  const head: string[] = [];
  if (notice.status === 'open') head.push('征求意见中');
  else if (notice.status === 'closed') head.push('已截止');
  else head.push('已出结果');
  if (notice.deadlineAt !== null) head.push(`截止 ${notice.deadlineAt}`);
  if (notice.agency !== '') head.push(`发布机关：${notice.agency}`);
  const excerpt = (notice.bodyText ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${head.join(' · ')}。${excerpt}`;
}

/** 条目页元数据：标题即公示标题，分享链接带 canonical 与 og:url（搜索/转发场景）。 */
export async function generateMetadata({ params }: NoticeDetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const notice = await getNoticeById(id);
  if (!notice) {
    return { title: '未找到该公示 —— 主人翁' };
  }
  const url = `${siteUrl()}/notices/${notice.id}`;
  const description = noticeDescription(notice);
  return {
    title: `${notice.title} —— 主人翁`,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'article',
      title: notice.title,
      description,
      url,
      publishedTime: notice.publishedAt ?? undefined,
    },
  };
}

export default async function NoticeDetailPage({ params }: NoticeDetailPageProps) {
  const { id } = await params;
  const notice = await getNoticeById(id);
  if (!notice) {
    notFound();
  }
  const source = await getSourceById(notice.sourceId);
  // 摘要列（issue #4）：done → 渲染五段式摘要；pending / failed_review → 占位
  const summaryInfo = await getNoticeSummary(notice.id);
  // 结构化速读（issue #26/#27）：纯函数、请求期算一次，对存量条目立即生效。
  // 提交方式块与速读卡共用这一份结果，避免同一段正文解析两遍。
  const brief = buildNoticeBrief({
    title: notice.title,
    bodyText: notice.bodyText,
    url: notice.url,
  });

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

        {notice.versionOf ? (
          <p className="version-line" data-testid="version-line">
            这是第 {notice.versionSeq ?? 1} 轮公示。
            <Link
              href={`/notices/${notice.id}/diff`}
              className="diff-entry-link"
              data-testid="compare-previous-link"
            >
              对比上一版
            </Link>
          </p>
        ) : null}

        {/* 摘要区（issue #4 / #22 / #27）：已有摘要照常渲染（绝不隐藏库内内容）；
            未生成时先给「结构化速读」（确定性抽取，不依赖大模型），再按 LLM 端口
            是否可用区分「生成中」占位与「暂未启用」说明 */}
        {summaryInfo?.aiSummaryJson ? (
          <SummaryView
            notice={notice}
            summaryJson={summaryInfo.aiSummaryJson}
            summaryModel={summaryInfo.summaryModel}
          />
        ) : (
          <>
            <NoticeBriefView brief={brief} url={notice.url} />
            {llmReady() ? (
              <SummaryPlaceholder status={summaryInfo?.summaryStatus ?? 'pending'} />
            ) : (
              <SummaryUnavailable />
            )}
          </>
        )}

        <section className="action-slot">
          <a
            className="go-button"
            href={`/go/${notice.id}`}
            data-testid="go-official-button"
          >
            去官方渠道提意见
          </a>
          {/* 提交方式（issue #27）：原文里写着的具体渠道。放在按钮旁——读者点了
              按钮要跳走，此处先给「跳过去之后往哪儿提」。取不到时整块不渲染。 */}
          <SubmissionChannels channels={brief.channels} />
          <div className="how-to" data-testid="how-to-comment">
            <p className="how-to-title">分步提意指引</p>
            <ol>
              <li>
                点击上方「去官方渠道提意见」按钮，跳转到
                <a href={`/go/${notice.id}`}>官方原文页面</a>
                （本站只引流，不代替官方受理意见）。
              </li>
              <li>在官方页面阅读公告全文，确认征求意见的截止日期与受理范围。</li>
              <li>
                {brief.channels.length > 0
                  ? '本公示已在原文中注明具体提交方式（见上方「意见提交方式」），按其办理；建议附上具体条款与修改建议。'
                  : '按官方页面指引提交意见：通常可通过在线表单、电子邮件或信函提出，建议附上具体条款与修改建议。'}
              </li>
              <li>截止日期前提交的意见才会被纳入汇总，请留意页面上的截止时间。</li>
            </ol>
          </div>
          <p className="click-stats" data-testid="outbound-clicks">
            出站提意点击：{notice.outboundClicks} 次
          </p>
          {/* 订阅提醒入口（issue #17）：详情页是「想参与」意向最强的时刻；
              邮件端口未配置时不渲染（不挂必然失败的死流程） */}
          {mailerReady() ? (
            <p className="subscribe-hint">
              不想错过同类公示？
              <Link href="/subscribe" data-testid="subscribe-detail-link">
                订阅截止提醒
              </Link>
              —— 按关键词或领域，在截止前 7 天、3 天各收一封提醒邮件。
            </p>
          ) : null}
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
