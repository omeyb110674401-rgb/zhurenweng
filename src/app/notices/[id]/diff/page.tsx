import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getNoticeById } from '@/db/repo/notices';
import { getSourceById } from '@/db/repo/sources';
import { formatDate } from '@/app/_lib/notice-display';
import {
  diffNoticeBodies,
  type DiffRow,
  type DiffSegment,
} from '@/lib/notice-diff';

// 对比数据随抓取管线更新，服务端实时渲染。
export const dynamic = 'force-dynamic';

interface NoticeDiffPageProps {
  params: Promise<{ id: string }>;
}

/**
 * 条款对比视图（issue #10）：/notices/[id]/diff。
 * 对存在上一版（versionOf 非空）的条目，按条款（章 / 条 / 段落）呈现新旧
 * 差异：新增 / 删除 / 修改三态高亮；显著提示当前轮次与上一轮发布日期。
 */
export default async function NoticeDiffPage({ params }: NoticeDiffPageProps) {
  const { id } = await params;
  const notice = await getNoticeById(id);
  if (!notice) {
    notFound();
  }
  const source = await getSourceById(notice.sourceId);
  const previous = notice.versionOf ? await getNoticeById(notice.versionOf) : null;

  if (!previous) {
    return (
      <main>
        <nav className="breadcrumb">
          <Link href={`/notices/${notice.id}`}>← 返回详情页</Link>
        </nav>
        <article className="diff-page">
          <h1 className="detail-title">条款对比</h1>
          <div className="diff-empty" data-testid="diff-empty">
            该条目没有可对比的上一版本（同一法案的此前轮次公示未被收录或未关联）。
          </div>
        </article>
      </main>
    );
  }

  const rows = diffNoticeBodies(previous.bodyText, notice.bodyText);
  const versionSeq = notice.versionSeq ?? 1;

  return (
    <main>
      <nav className="breadcrumb">
        <Link href={`/notices/${notice.id}`}>← 返回详情页</Link>
      </nav>

      <article className="diff-page">
        <header className="detail-header">
          <h1 className="detail-title">条款对比：{notice.title}</h1>
          <p className="diff-banner" data-testid="diff-version-banner">
            这是第 {versionSeq} 轮征求意见稿，与上一轮（{formatDate(previous.publishedAt)}）对比
          </p>
          <div className="diff-versions">
            <div className="diff-version diff-version-old">
              <span className="diff-version-label">上一轮</span>
              <Link
                href={`/notices/${previous.id}`}
                className="diff-version-title"
                data-testid="diff-previous-link"
              >
                {previous.title}
              </Link>
              <span className="diff-version-date">发布：{formatDate(previous.publishedAt)}</span>
            </div>
            <div className="diff-version diff-version-new">
              <span className="diff-version-label">本轮</span>
              <span className="diff-version-title">{notice.title}</span>
              <span className="diff-version-date">发布：{formatDate(notice.publishedAt)}</span>
            </div>
          </div>
          <p className="diff-legend">
            图例：<ins className="diff-ins">新增内容</ins> /{' '}
            <del className="diff-del">删除内容</del>，行首标记区分 新增 / 删除 / 修改 条款。
          </p>
        </header>

        {rows.length > 0 ? (
          <section className="diff-rows" data-testid="diff-rows">
            {rows.map((row, index) => (
              <DiffRowView key={index} row={row} />
            ))}
          </section>
        ) : (
          <div className="diff-empty" data-testid="diff-no-body">
            两轮公示暂无可比对的正文文本（官方页面未提供草案正文），请前往官方原文查看。
          </div>
        )}
      </article>

      <footer className="site-footer">
        <p>
          差异由站内自动比对生成，仅供参考；条款内容以官方原文为准，
          <a href={notice.url} target="_blank" rel="noopener noreferrer">
            查看本轮官方原文
          </a>
          （{source?.name ?? notice.sourceId}）。
        </p>
      </footer>
    </main>
  );
}

/** 单条差异行：三态徽标 + 文本（修改行为旧 / 新双行带行内高亮）。 */
function DiffRowView({ row }: { row: DiffRow }) {
  if (row.kind === 'modified' && row.old && row.new) {
    return (
      <div className="diff-row diff-row-modified" data-testid="diff-modified">
        <span className="diff-badge diff-badge-modified">修改</span>
        <div className="diff-text">
          <p className="diff-side diff-side-old">
            {renderSegments(row.oldSegments ?? [], 'old')}
          </p>
          <p className="diff-side diff-side-new">
            {renderSegments(row.newSegments ?? [], 'new')}
          </p>
        </div>
      </div>
    );
  }
  if (row.kind === 'added' && row.new) {
    return (
      <div className="diff-row diff-row-added" data-testid="diff-added">
        <span className="diff-badge diff-badge-added">新增</span>
        <div className="diff-text">{row.new.text}</div>
      </div>
    );
  }
  if (row.kind === 'removed' && row.old) {
    return (
      <div className="diff-row diff-row-removed" data-testid="diff-removed">
        <span className="diff-badge diff-badge-removed">删除</span>
        <div className="diff-text">{row.old.text}</div>
      </div>
    );
  }
  return (
    <div className="diff-row diff-row-same">
      <span className="diff-badge diff-badge-same">相同</span>
      <div className="diff-text">{row.old?.text ?? row.new?.text}</div>
    </div>
  );
}

/** 字符级片段渲染：删除内容 <del>，新增内容 <ins>，其余原样。 */
function renderSegments(segments: DiffSegment[], side: 'old' | 'new') {
  return segments.map((segment, index) => {
    if (segment.type === 'del') {
      return (
        <del key={index} className="diff-del" data-testid={`diff-del-${side}`}>
          {segment.text}
        </del>
      );
    }
    if (segment.type === 'ins') {
      return (
        <ins key={index} className="diff-ins" data-testid={`diff-ins-${side}`}>
          {segment.text}
        </ins>
      );
    }
    return <span key={index}>{segment.text}</span>;
  });
}
