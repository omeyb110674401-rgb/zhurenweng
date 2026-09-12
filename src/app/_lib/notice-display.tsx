import type { ReactNode } from 'react';
import type { NoticeRecord, NoticeStatus } from '@/db/types';
import { daysUntil } from '@/lib/dates';

/**
 * 公示条目的展示组件（列表页与详情页共用）。
 * 状态徽标取自库中 status 字段（抓取时按截止日期推导）；倒计时按本地日历日
 * 计算，仅在「征求意见中」时展示。
 */

const STATUS_LABELS: Record<NoticeStatus, string> = {
  open: '征求意见中',
  closed: '已截止',
  resulted: '已出结果',
};

export function StatusBadge({ status }: { status: NoticeStatus }) {
  return (
    <span className={`status-badge status-${status}`} data-testid="notice-status-badge">
      {STATUS_LABELS[status]}
    </span>
  );
}

/** 截止倒计时文案；非征求意见中或不带截止日期时返回 null（不展示）。 */
export function countdownText(notice: NoticeRecord, now: Date): string | null {
  if (notice.status !== 'open') return null;
  const days = daysUntil(notice.deadlineAt, now);
  if (days === null) return null;
  if (days < 0) return null;
  if (days === 0) return '今天截止';
  if (days === 1) return '明天截止';
  return `剩 ${days} 天`;
}

export function Countdown({ notice, now }: { notice: NoticeRecord; now: Date }): ReactNode {
  const text = countdownText(notice, now);
  if (text === null) return null;
  return (
    <span className={`countdown${text === '今天截止' || text === '明天截止' ? ' countdown-urgent' : ''}`} data-testid="notice-countdown">
      {text}
    </span>
  );
}

/** 首页与详情页共用的日期格式化：保持 ISO 日期原样，缺失时给占位文案。 */
export function formatDate(iso: string | null): string {
  return iso ?? '未标注';
}
