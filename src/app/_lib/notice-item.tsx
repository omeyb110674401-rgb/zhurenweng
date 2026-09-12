import Link from 'next/link';
import type { NoticeRecord } from '@/db/types';
import { Countdown, StatusBadge, formatDate } from '@/app/_lib/notice-display';

/**
 * 公示条目的列表项展示（issue #8 自列表页抽取共用）：聚合列表页与
 * 搜索结果页渲染同一组件 —— 结果项复用列表条目展示（状态徽标、截止
 * 倒计时、领域标签（issue #9）、发布机关 / 发布日期 / 截止日期与详情页链接）。
 */
export function NoticeItem({ notice }: { notice: NoticeRecord }) {
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
