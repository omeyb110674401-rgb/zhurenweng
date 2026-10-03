import Link from 'next/link';
import type { NoticeRecord } from '@/db/types';
import { Countdown, StatusBadge, formatDate } from '@/app/_lib/notice-display';
import { effectiveStatus } from '@/lib/notice-status';
import { isNewNotice } from '@/lib/notice-recency';
import { parseQuotedSummary } from '@/lib/summary-content';
import { NOTICE_MARK_HINTS, NOTICE_MARK_LABELS, noticeMarks } from '@/lib/notice-marks';

/**
 * 公示条目的列表项展示（issue #8 自列表页抽取共用）：聚合列表页与
 * 搜索结果页渲染同一组件 —— 结果项复用列表条目展示（状态徽标、截止
 * 倒计时、领域标签（issue #9）、发布机关 / 发布日期 / 截止日期与详情页链接）。
 *
 * 徽标取**展示用有效状态**（issue #43）：库内 status 是每日抓取时推导的，
 * 刚过截止的条目在下一轮抓取前仍是 open —— 列表不能因此说它还能提意见。
 *
 * 「这条里有什么」的标记（issue #87，2026-10-03 拍板）：判读与改动对照此前**只存在于详情页
 * 渲不渲染**，读者必须先点进去才知道值不值得读。判据全在 `lib/notice-marks.ts`（页面里的分支
 * 进不了自证框架），这里只负责摆放与"空数组就不渲染"。
 *
 * `showMarks` 默认 **true**、由**搜索页显式关掉**（用户 2026-10-03 拍板"只首页"）：
 * 默认开着是因为它是列表页的应有之义，新加一个列表入口时不会静默漏掉；
 * 搜索页那一处带着"为什么这里不要"的注释（例外写在例外发生的地方，而不是写在默认值里）。
 */
export function NoticeItem({
  notice,
  showMarks = true,
}: {
  notice: NoticeRecord;
  showMarks?: boolean;
}) {
  const now = new Date();
  /**
   * 摘要**只解析一次**并复用（`noticeMarks` 收已解析的形状，不再自己解析一遍）。
   * `notice.aiSummary` 是 `unknown`（列是 TEXT / JSON），`parseQuotedSummary` 对旧形状与
   * 缺键一律宽容 —— 存量行不会因为这一刀变成"形状异常"。
   */
  const marks = showMarks
    ? noticeMarks({ audience: notice.audience, summary: parseQuotedSummary(notice.aiSummary) })
    : [];
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
        {/* 标记是**文本**不是图标（读屏拿得到），完整说明挂 `title` —— 列表不因此变长。
            多个标记各是一个 `<span>`：`data-mark` 让 e2e 能分辨是哪一种，而不是只数个数 */}
        {marks.map((mark) => (
          <span
            key={mark}
            className="notice-mark"
            data-testid="notice-mark"
            data-mark={mark}
            title={NOTICE_MARK_HINTS[mark]}
          >
            {NOTICE_MARK_LABELS[mark]}
          </span>
        ))}
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
