import Link from 'next/link';
import type { NoticeRecord } from '@/db/types';
import { Countdown, StatusBadge, formatDate } from '@/app/_lib/notice-display';
import { effectiveStatus } from '@/lib/notice-status';
import { isNewNotice } from '@/lib/notice-recency';

/**
 * 公示条目的列表项展示（issue #8 自列表页抽取共用）：聚合列表页与
 * 搜索结果页渲染同一组件 —— 结果项复用列表条目展示（状态徽标、截止
 * 倒计时、领域标签（issue #9）、发布机关 / 发布日期 / 截止日期与详情页链接）。
 *
 * 徽标取**展示用有效状态**（issue #43）：库内 status 是每日抓取时推导的，
 * 刚过截止的条目在下一轮抓取前仍是 open —— 列表不能因此说它还能提意见。
 */
export function NoticeItem({ notice }: { notice: NoticeRecord }) {
  const now = new Date();
  return (
    <li className="notice-item" data-testid="notice-item">
      <div className="notice-item-head">
        <StatusBadge status={effectiveStatus(notice, now)} />
        <Countdown notice={notice} now={now} />
        {/* 「新」= 最近被收录（issue #62，判据是 first_seen_at 而非抓取时间）。
            与首页的「近 N 天收录」入口是两套窗口：角标固定 7 天，不跟筛选走 ——
            选「近 90 天」时若人人带角标，这个标记就不再传递任何信息 */}
        {isNewNotice(notice.firstSeenAt, now) ? (
          <span className="notice-new-badge" data-testid="notice-new-badge">
            新
          </span>
        ) : null}
      </div>
      <Link className="notice-title" href={`/notices/${notice.id}`} data-testid="notice-title-link">
        {notice.title}
      </Link>
      <div className="notice-meta">
        {notice.agency} · 发布：{formatDate(notice.publishedAt)} · 截止：
        {formatDate(notice.deadlineAt)}
      </div>
      {notice.categoryTags.length > 0 && (
        <div className="notice-tags" data-testid="notice-category-tags">
          {notice.categoryTags.map((tag) => (
            <span key={tag} className="notice-tag" data-testid="notice-category-tag">
              {tag}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}
