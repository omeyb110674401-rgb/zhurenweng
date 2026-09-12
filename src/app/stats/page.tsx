import Link from 'next/link';
import {
  getAgencyMonthlyCounts,
  getAgencyTotals,
  getClicksByDate,
  getPeriodLengthDistribution,
  getStatsOverview,
  getTopClickedNotices,
  type AgencyMonthCount,
  type AgencyTotal,
} from '@/db/repo/stats';

// 统计随抓取管线与点击实时变化，服务端实时渲染，不做静态预渲染。
export const dynamic = 'force-dynamic';

export const metadata = {
  title: '数据统计 —— 主人翁',
};

/** 趋势窗口：最近 6 个日历月（含当前月），返回月份升序（YYYY-MM）。 */
const TREND_MONTHS = 6;

function lastMonthWindow(now: Date): string[] {
  const months: string[] = [];
  const cursor = new Date(now.getFullYear(), now.getMonth(), 1);
  for (let i = 0; i < TREND_MONTHS; i += 1) {
    months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`);
    cursor.setMonth(cursor.getMonth() - 1);
  }
  return months.reverse();
}

/** 公示期分布桶的页面文案（与 repo 层桶 key 一一对应，顺序固定）。 */
const PERIOD_LABELS: Record<string, string> = {
  lte7: '7 天以内（含 7 天）',
  b8_15: '8-15 天',
  b16_30: '16-30 天',
  gt30: '30 天以上',
};

export default async function StatsPage() {
  const now = new Date();
  const [overview, agencyTotals, monthlyCounts, periodDistribution, topClicked, clicksByDate] =
    await Promise.all([
      getStatsOverview(),
      getAgencyTotals(),
      getAgencyMonthlyCounts(),
      getPeriodLengthDistribution(),
      getTopClickedNotices(10),
      getClicksByDate(30),
    ]);

  const months = lastMonthWindow(now);
  const monthSet = new Set(months);
  // 窗口内（机关 × 月）计数；窗口外的历史月份不计入趋势表
  const windowCounts = monthlyCounts.filter((row) => monthSet.has(row.month));
  const windowByAgency = groupWindowByAgency(windowCounts);
  const trendAgencies = [...windowByAgency.entries()].sort(
    (a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]),
  );
  const monthTotals = months.map((month) =>
    windowCounts.filter((row) => row.month === month).reduce((sum, row) => sum + row.count, 0),
  );

  const periodMax = Math.max(...periodDistribution.map((bucket) => bucket.count), 1);
  const hasNotices = overview.totalNotices > 0;

  return (
    <main>
      <nav className="breadcrumb">
        <Link href="/">← 返回公示列表</Link>
      </nav>

      <header className="site-header">
        <h1 className="brand">
          主人<span className="brand-accent">翁</span>
        </h1>
        <p className="tagline">数据统计 —— 政务公开活动趋势与出站提意点击（北极星指标）</p>
        <p className="stats-overview" data-testid="stats-overview">
          收录公示 <strong data-testid="stats-total-notices">{overview.totalNotices}</strong> 条
          · 累计出站提意点击{' '}
          <strong data-testid="stats-total-clicks">{overview.totalClicks}</strong> 次
        </p>
      </header>

      <section className="stats-section" aria-labelledby="stats-agency-title">
        <h2 id="stats-agency-title">各部门公示量</h2>
        <p className="section-hint">按发布机关聚合的公示条目数（全部收录历史）。</p>
        {agencyTotals.length === 0 ? (
          <EmptyBlock testId="stats-agency-empty" text="暂无公示数据，抓取管线收录后这里将按部门聚合展示。" />
        ) : (
          <table className="stat-table" data-testid="agency-totals-table">
            <thead>
              <tr>
                <th scope="col">发布机关</th>
                <th scope="col" className="stat-num">
                  公示量
                </th>
              </tr>
            </thead>
            <tbody>
              {agencyTotals.map((row: AgencyTotal) => (
                <tr key={row.agency} data-testid="agency-total-row">
                  <th scope="row">{row.agency}</th>
                  <td className="stat-num">{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="stats-section" aria-labelledby="stats-trend-title">
        <h2 id="stats-trend-title">公示量月度趋势（最近 {TREND_MONTHS} 个月）</h2>
        <p className="section-hint">按发布日期所在月份统计（{months[0]} 至 {months[months.length - 1]}）。</p>
        {trendAgencies.length === 0 ? (
          <EmptyBlock
            testId="stats-trend-empty"
            text={`最近 ${TREND_MONTHS} 个月内暂无公示发布，趋势将随数据收录逐步呈现。`}
          />
        ) : (
          <table className="stat-table" data-testid="trend-table">
            <thead>
              <tr>
                <th scope="col">发布机关</th>
                {months.map((month) => (
                  <th scope="col" className="stat-num" key={month}>
                    {month}
                  </th>
                ))}
                <th scope="col" className="stat-num">
                  小计
                </th>
              </tr>
            </thead>
            <tbody>
              {trendAgencies.map(([agency, series]) => (
                <tr key={agency} data-testid="trend-row">
                  <th scope="row">{agency}</th>
                  {months.map((month) => (
                    <td className="stat-num" key={month} data-month={month}>
                      {series.byMonth.get(month) ?? 0}
                    </td>
                  ))}
                  <td className="stat-num stat-total">{series.total}</td>
                </tr>
              ))}
              <tr data-testid="trend-total-row">
                <th scope="row">全部机关</th>
                {monthTotals.map((total, index) => (
                  <td className="stat-num stat-total" key={months[index]}>
                    {total}
                  </td>
                ))}
                <td className="stat-num stat-total">
                  {monthTotals.reduce((sum, total) => sum + total, 0)}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </section>

      <section className="stats-section" aria-labelledby="stats-period-title">
        <h2 id="stats-period-title">公示期长度分布</h2>
        <p className="section-hint">
          公示期长度 = 截止日期 - 发布日期（按日历日）；缺失发布或截止日期的条目不参与统计。
        </p>
        {!hasNotices || periodDistribution.every((bucket) => bucket.count === 0) ? (
          <EmptyBlock testId="stats-period-empty" text="暂无可统计的公示期数据。" />
        ) : (
          <ul className="period-buckets" data-testid="period-buckets">
            {periodDistribution.map((bucket) => (
              <li key={bucket.key} data-testid="period-bucket-row" data-bucket={bucket.key}>
                <span className="period-label">{PERIOD_LABELS[bucket.key]}</span>
                <span className="period-bar" aria-hidden="true">
                  <span
                    className="period-bar-fill"
                    style={{ width: `${Math.round((bucket.count / periodMax) * 100)}%` }}
                  />
                </span>
                <span className="period-count">{bucket.count} 条</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="stats-section" aria-labelledby="stats-clicks-title">
        <h2 id="stats-clicks-title">出站提意点击（北极星指标）</h2>
        <p className="section-hint">
          「去官方渠道提意见」按钮的跳转点击聚合，纯计数统计，不记录任何个人身份
          （无 IP、无 Cookie、无账号）。
        </p>
        <h3>条目点击 Top 10</h3>
        {topClicked.length === 0 ? (
          <EmptyBlock testId="stats-top-clicks-empty" text="暂无出站点击记录，访客从详情页跳转官方原文后这里将出现热门条目。" />
        ) : (
          <ol className="top-clicks" data-testid="top-clicks">
            {topClicked.map((notice) => (
              <li key={notice.id} data-testid="top-click-row">
                <Link className="top-click-link" href={`/notices/${notice.id}`} data-testid="top-click-link">
                  {notice.title}
                </Link>
                <span className="top-click-meta">
                  {notice.agency} · {notice.outboundClicks} 次
                </span>
              </li>
            ))}
          </ol>
        )}
        <h3>按日期聚合</h3>
        {clicksByDate.length === 0 ? (
          <EmptyBlock testId="stats-clicks-by-date-empty" text="暂无出站点击记录。" />
        ) : (
          <ul className="clicks-by-date" data-testid="clicks-by-date">
            {clicksByDate.map((row) => (
              <li key={row.date} data-testid="click-date-row" data-date={row.date}>
                {row.date}：<strong>{row.clicks}</strong> 次
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="site-footer">
        <p>
          统计数据全部来自本站收录的官方公开信息与站内跳转点击的纯计数聚合，
          不涉及任何个人身份信息。
        </p>
      </footer>
    </main>
  );
}

function groupWindowByAgency(rows: AgencyMonthCount[]): Map<string, { byMonth: Map<string, number>; total: number }> {
  const byAgency = new Map<string, { byMonth: Map<string, number>; total: number }>();
  for (const row of rows) {
    let series = byAgency.get(row.agency);
    if (!series) {
      series = { byMonth: new Map(), total: 0 };
      byAgency.set(row.agency, series);
    }
    series.byMonth.set(row.month, (series.byMonth.get(row.month) ?? 0) + row.count);
    series.total += row.count;
  }
  return byAgency;
}

function EmptyBlock({ testId, text }: { testId: string; text: string }) {
  return (
    <div className="empty-state" data-testid={testId}>
      <p className="empty-hint">{text}</p>
    </div>
  );
}
