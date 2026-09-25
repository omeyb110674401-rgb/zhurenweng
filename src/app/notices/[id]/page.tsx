import Link from 'next/link';
import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getNoticeById } from '@/db/repo/notices';
import { getNoticeSummary } from '@/db/repo/summaries';
import { getNoticeAttachmentExtractReport } from '@/db/repo/attachments';
import { getSourceById } from '@/db/repo/sources';
import { Countdown, StatusBadge, formatDate } from '@/app/_lib/notice-display';
import { NoticeBriefView, SubmissionChannels } from '@/app/_lib/notice-brief-view';
import { SummaryNotGenerated, SummaryPlaceholder, SummaryUnavailable, SummaryView } from '@/app/_lib/summary-view';
import { buildNoticeBrief, mergeSubmissionChannels } from '@/lib/notice-brief';
import { channelGuidance } from '@/lib/channel-guidance';
import { parseQuotedSummary } from '@/lib/summary-content';
import { summaryDisplayState } from '@/lib/summary-display';
import { buildNoticeJsonLd, serializeJsonLd } from '@/lib/notice-jsonld';
import { effectiveStatus } from '@/lib/notice-status';
import { GENRE_LABELS } from '@/lib/notice-genre';
import { llmReady } from '@/lib/llm-availability';
import { mailerReady } from '@/lib/mailer-availability';
import { OG_IMAGE } from '@/lib/page-metadata';
import { siteUrl } from '@/lib/site-url';
import { safeParseJson, type NoticeRecord } from '@/db/types';
import { SiteFooter } from '@/app/_lib/site-footer';

// 详情数据随抓取管线更新，服务端实时渲染。
export const dynamic = 'force-dynamic';

interface NoticeDetailPageProps {
  params: Promise<{ id: string }>;
}

/**
 * 同一请求内只查一次（issue #53）：`generateMetadata` 与页面渲染都要这条记录，
 * 此前各查一遍 —— 同一个 id 在同一个请求里打两次库。`cache()` 是 React 的
 * **请求级**记忆化：不跨请求、不引入失效问题（页面本身是 force-dynamic）。
 */
const getNoticeCached = cache(getNoticeById);

/**
 * 条目的分享 / 检索摘要（可发现性）：状态 + 截止日期 + 机关 + 正文首段。
 * 搜索结果的描述片段直接影响点击率，「什么时候截止」放最前。
 *
 * 状态取**展示用有效状态**（issue #43）：摘要里写「征求意见中」是给读者看的
 * 判断，不能沿用每日一轮的状态列 —— 刚过截止的条目在下一轮抓取前仍会写着
 * 「征求意见中」，而分享出去以后没人会回来纠正。
 */
function noticeDescription(notice: NoticeRecord, now: Date): string {
  const head: string[] = [];
  const status = effectiveStatus(notice, now);
  if (status === 'open') head.push('征求意见中');
  else if (status === 'closed') head.push('已截止');
  else head.push('已出结果');
  if (notice.deadlineAt !== null) head.push(`截止 ${notice.deadlineAt}`);
  if (notice.agency !== '') head.push(`发布机关：${notice.agency}`);
  const excerpt = (notice.bodyText ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${head.join(' · ')}。${excerpt}`;
}

/** 条目页元数据：标题即公示标题，分享链接带 canonical 与 og:url（搜索/转发场景）。 */
export async function generateMetadata({ params }: NoticeDetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const notice = await getNoticeCached(id);
  if (!notice) {
    return { title: '未找到该公示 —— 主人翁' };
  }
  const url = `${siteUrl()}/notices/${notice.id}`;
  const description = noticeDescription(notice, new Date());
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
      // 分享图要显式带上（issue #53）：页面自己导出 openGraph 会把父级的整块覆盖，
      // 此前详情页的分享卡片一直没有图
      images: [OG_IMAGE],
    },
  };
}

export default async function NoticeDetailPage({ params }: NoticeDetailPageProps) {
  const { id } = await params;
  const notice = await getNoticeCached(id);
  if (!notice) {
    notFound();
  }
  // 展示用有效状态（issue #43）：库内 status 是每日抓取时推导的，刚过截止的条目
  // 在下一轮抓取前仍是 open —— 徽标、分享摘要与结构化数据都必须按当前日期复核，
  // 否则页面会声称一个已关闭的征集还能提意见（倒计时此时已静默消失）。
  const now = new Date();
  const status = effectiveStatus(notice, now);
  // 来源名与摘要列互不依赖，并行取（issue #53）：此前是两次串行 await，等于把
  // 两个查询的往返时间相加。摘要列（issue #4）：done → 渲染五段式摘要；
  // pending / failed_review → 占位。
  const [source, summaryInfo, attachmentRows] = await Promise.all([
    getSourceById(notice.sourceId),
    getNoticeSummary(notice.id),
    getNoticeAttachmentExtractReport(notice.id),
  ]);
  // 「条文在哪」这句话的依据（issue #57 第 6 步）。刻意不把「抽取表里没有行」直接当成
  // 「没有随文附件」—— 前者也可能是抽取还没跑到这条（新入库条目，或该源被排除在抽取之外）。
  // 分不清就报「未探测」，让页面回到通用文案，而不是说一句可能被数据打脸的话。
  const draftReport =
    attachmentRows.total > 0
      ? attachmentRows
      : notice.attachments.length === 0
        ? { total: 0, fedChars: 0, okFiles: 0 }
        : null;
  // 摘要区该说什么（issue #58）：判定收在纯函数里，页面只按态选块。注意传的是
  // **库列** notice.status 而不是上面的展示状态 —— 摘要任务的入队过滤看的就是它。
  const summaryDisplay = summaryDisplayState({
    hasSummary: Boolean(summaryInfo?.aiSummaryJson),
    summaryStatus: summaryInfo?.summaryStatus ?? 'pending',
    noticeStatus: notice.status,
    llmReady: llmReady(),
  });
  // 结构化速读（issue #26/#27）：纯函数、请求期算一次，对存量条目立即生效。
  // 提交方式块与速读卡共用这一份结果，避免同一段正文解析两遍。
  const brief = buildNoticeBrief({
    title: notice.title,
    bodyText: notice.bodyText,
    url: notice.url,
  });
  // 渠道在页面上只有一个渲染位置（issue #56）：程序逐字抽取的是权威源，AI 摘要抽到的
  // 地址并入同一份清单并标「摘要补充」。摘要卡不再自己列一份 —— 同一个邮箱在一屏出现
  // 两遍（且第二份出处更弱）是这次重构实测出来的问题，不是假想。
  const submissionChannels = mergeSubmissionChannels(
    brief.channels,
    summaryInfo?.aiSummaryJson
      ? (parseQuotedSummary(safeParseJson(summaryInfo.aiSummaryJson))?.channels ?? [])
      : [],
  );
  // 取不到渠道时**为什么**取不到（issue #64）：判据与「条文在哪」同一份附件报告，
  // 页面只按结论选文案 —— 空着不说话会被读成「这条不接受意见」，而那不是事实。
  const channelAdvice = channelGuidance({
    hasChannels: submissionChannels.length > 0,
    bodyChars: (notice.bodyText ?? '').length,
    attachmentReport: draftReport,
  });
  // 结构化数据（issue #39）：与 metadata 用同一份摘要，避免两处描述分叉。
  const jsonLd = serializeJsonLd(
    buildNoticeJsonLd({
      notice,
      siteUrl: siteUrl(),
      description: noticeDescription(notice, now),
      status,
    }),
  );

  return (
    <main id="main-content">
      {/* schema.org 结构化数据（issue #39）：给搜索引擎/聚合器读的机器可读版本，
          字段口径见 lib/notice-jsonld.ts；用户可见内容全在下方，此处不重复渲染 */}
      <script
        type="application/ld+json"
        data-testid="notice-jsonld"
        dangerouslySetInnerHTML={{ __html: jsonLd }}
      />
      <nav className="breadcrumb">
        <Link href="/">← 返回公示列表</Link>
      </nav>

      <article className="notice-detail">
        <header className="detail-header">
          <div className="detail-badges">
            <StatusBadge status={status} />
            <Countdown notice={notice} now={new Date()} />
            {/*
             * 体裁角标（issue #76）。放在详情页而不是只存库里：读者得知道自己正在读的是
             * "一份改现行的修正案"还是"一部新起草的规定"——这两种公告该看的重点不一样，
             * 而摘要的形态也正因为如此才不同。未判定不显示（没有信息量的角标只会占位置）。
             */}
            {notice.genre !== null && notice.genre !== 'unknown' ? (
              <span className="genre-badge" data-testid="notice-genre-badge">
                {GENRE_LABELS[notice.genre]}
              </span>
            ) : null}
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

        {/* 摘要区（issue #4 / #22 / #27 / #58）：已有摘要照常渲染（绝不隐藏库内内容）；
            未生成时先给「结构化速读」（确定性抽取，不依赖大模型），再按 summaryDisplayState
            区分「生成中」/「待人工复核」/「未生成摘要」/「暂未启用」。 */}
        {summaryInfo?.aiSummaryJson ? (
          <SummaryView
            notice={notice}
            summaryJson={summaryInfo.aiSummaryJson}
            summaryModel={summaryInfo.summaryModel}
            attachmentReport={draftReport}
          />
        ) : (
          <>
            <NoticeBriefView brief={brief} url={notice.url} />
            {summaryDisplay === 'unavailable' ? (
              <SummaryUnavailable />
            ) : summaryDisplay === 'not-generated' ? (
              <SummaryNotGenerated />
            ) : (
              <SummaryPlaceholder status={summaryInfo?.summaryStatus ?? 'pending'} />
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
              按钮要跳走，此处先给「跳过去之后往哪儿提」。取不到时不再留白，
              而是说明为什么取不到（issue #64），仍然不编一条凑数。 */}
          <SubmissionChannels channels={submissionChannels} guidance={channelAdvice} url={notice.url} />
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
                {submissionChannels.length > 0
                  ? '本公示已在原文中注明具体提交方式（见上方「意见提交方式」），按其办理；建议附上具体条款与修改建议。'
                  : '到官方原文页面上找「反馈方式 / 意见反馈」那一段并按其办理（上方已说明本站为什么没取到渠道）；建议附上具体条款与修改建议。'}
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
                订阅公示提醒
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
            {/*
              附件打不开时的出路（issue #35）：实测生产 340 个附件引用里有 31 个
              （全部来自工信部）在两类独立网络下都返回 403 —— 文件挂在
              jyhwzhq.miit.gov.cn 上，该主机对非白名单客户端一律拦（连根路径都 403），
              而官方页面链接的就是同一批 URL。我们**不隐藏**这些链接（同一条链接在
              用户浏览器里未必同样被拦，藏掉等于删掉可能可用的入口），但要让用户在
              点进一个陌生站点的错误页之前就知道还有官方原文这条路。
            */}
            <p className="attachment-hint" data-testid="attachment-fallback">
              附件打不开？部分政府站点对下载有网络或会话限制，可到
              <a href={notice.url} target="_blank" rel="noopener noreferrer">
                官方原文页面
              </a>
              获取。
            </p>
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

      <SiteFooter />
    </main>
  );
}
