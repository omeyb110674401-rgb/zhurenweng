import type { ReactNode } from 'react';
import type { NoticeRecord, NoticeStatus } from '@/db/types';
import { countdownView } from '@/lib/notice-countdown';
import { noticeStatusLabel } from '@/lib/notice-status';

/**
 * 公示条目的展示组件（列表页与详情页共用）。
 *
 * 状态徽标取自**展示用有效状态**（issue #43 的 `effectiveStatus`：库内 status 是抓取时
 * 推导的，刚过截止的条目在下一轮抓取前仍是 open）；倒计时按站点日历日（东八区）计算，
 * 只在同一条判据说「这条还在征求意见」时展示 —— 那个判据与它的紧迫度分档都在
 * `lib/notice-countdown.ts`（2026-10-07 抽出），这里只做摆放。
 *
 * 文案表在 lib/notice-status.ts（issue #51 起与结构化数据共用一份），未知取值
 * 原样显示 —— 不渲染 undefined。
 */

export function StatusBadge({ status }: { status: NoticeStatus }) {
  return (
    <span className={`status-badge status-${status}`} data-testid="notice-status-badge">
      {noticeStatusLabel(status)}
    </span>
  );
}

/**
 * 截止倒计时。
 *
 * 判据与分档全在 `lib/notice-countdown.ts`（`countdownDays` / `countdownText` /
 * `countdownView`）—— 为什么抽出去：分档边界是有产品含义的阈值，而 `.tsx` 里的分支
 * 进不了单测（Node 的类型剥离不吃 `.tsx`），只能靠源码文本断言，钉不住真值表。
 * 这里因此退化成纯模板：类名与文案都由判据给。
 */
export function Countdown({ notice, now }: { notice: NoticeRecord; now: Date }): ReactNode {
  const view = countdownView(notice, now);
  if (view === null) return null;
  return (
    <span className={view.className} data-testid="notice-countdown">
      {view.text}
    </span>
  );
}

/** 首页与详情页共用的日期格式化：保持 ISO 日期原样，缺失时给占位文案。 */
export function formatDate(iso: string | null): string {
  return iso ?? '未标注';
}

// 判据住在 lib/notice-countdown.ts，这里原样转发 —— 既有调用点（页面 / 测试）的
// import 路径不必跟着搬家，两处口径不会分叉。
export { countdownDays, countdownText } from '@/lib/notice-countdown';
