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
import { lastSiteMonths } from '@/lib/dates';
import { PERIOD_BUCKETS } from '@/lib/notice-period';
import { simplePageMetadata } from '@/lib/page-metadata';
import { SiteFooter } from '@/app/_lib/site-footer';

// 统计随抓取管线与点击实时变化，服务端实时渲染，不做静态预渲染。
export const dynamic = 'force-dynamic';

// 此前只有 title、没有 description（issue #53）：搜索结果与聊天软件里的链接预览
// 就只有一行标题，读者看不出这一页有什么。
export const metadata = simplePageMetadata({
  title: '数据统计',
  description:
    '本站收录的政府公示与征求意见稿聚合统计：各部门公示量月度趋势（可按机关与月份钻取）、公示期长度分布、出站点击（北极星指标），全部数字都可点开查看对应条目。',
  path: '/stats',
});

/** 趋势窗口：最近 6 个日历月（含当前月），返回月份升序（YYYY-MM）。 */
const TREND_MONTHS = 6;

/** 公示期分布桶的页面文案（与 repo 层桶 key 一一对应，顺序固定）。 */
// 桶标签与边界统一在 lib/notice-period.ts（issue #47）：标签从那份定义取，
// 不再在页面里另写一份 —— issue #46 的缺陷正是两份定义漂移（标签说「30 天以上」、
// 边界其实是 > 30）。
const PERIOD_LABELS: Record<string, string> = Object.fromEntries(
  PERIOD_BUCKETS.map((bucket) => [bucket.key, bucket.label]),
);


/**
 * 机关钻取链接：空机关名返回 null。
 *
 * 为什么不能照常给链接：`?agency=` 会被首页当成「未传该参数」（home-query.ts 的
 * firstParam 把空串视作未传），点进去是**未筛选**的全量列表，数字与表格不符。
 * 与其给一个说谎的链接，不如让那个数字保持不可点 —— issue #36 的规矩是
 * 「点进去的条数 = 表格上的数字」，不是「每个数字都必须能点」。
 */
function agencyDrillHref(agency: string, extra = ''): string | null {
  return agency === '' ? null : `/?agency=${encodeURIComponent(agency)}&lead=1${extra}`;
}

/**
 * 可钻取的数字：能表达出筛选条件且数字非零时渲染成链接，否则退化为纯文本。
 *
 * 两处退化各有理由：数字为 0 时点进去必然是空列表，链接只让读者白点一次；
 * 维度无法用 querystring 表达时（空机关名）给链接就是给假数字（见上）。
 * 收成一个组件而不是六处 `{n > 0 ? <Link> : n}`：原先趋势表总计那格为了算个和
 * 还要在 JSX 里写立即执行函数，可读性最差的那一处正是这么来的。
 */
function DrillNumber({
  count,
  href,
  testId,
  label,
  text,
}: {
  count: number;
  href: string | null;
  testId: string;
  label: string;
  text?: string;
}) {
  if (href === null || count === 0) return <>{text ?? count}</>;
  return (
    <Link className="stat-drill" href={href} data-testid={testId} aria-label={label}>
      {text ?? count}
    </Link>
  );
}

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

  const months = lastSiteMonths(now, TREND_MONTHS);
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
  // 未参与公示期统计的条数（缺截止日期或发布日期）：页面要说清差额，见上方的分桶说明
  const periodExcluded =
    overview.totalNotices -
    periodDistribution.reduce((sum, bucket) => sum + bucket.count, 0);
  const hasNotices = overview.totalNotices > 0;
  // 趋势表总计：窗口内各月合计之和（与行小计同源，口径见上方的分桶说明）
  const grandTotal = monthTotals.reduce((sum, total) => sum + total, 0);

  return (
    <main id="main-content">
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
        <p className="section-hint">
          按<strong>牵头机关</strong>聚合的公示条目数（全部收录历史）；联合发文只记在牵头机关名下，
          因此各部门之和等于条目总数。点击机关名可查看该机关牵头的条目（issue #36）。
        </p>
        {agencyTotals.length === 0 ? (
          <EmptyBlock testId="stats-agency-empty" text="暂无公示数据，抓取管线收录后这里将按部门聚合展示。" />
        ) : (
          <div
            className="stat-table-wrap"
            data-testid="stat-table-wrap"
            role="region"
            tabIndex={0}
            aria-label="各部门公示量表（窄屏可横向滚动）"
          >
          <table className="stat-table" data-testid="agency-totals-table">
            {/* 表格的可访问名称（issue #54）：读屏进到表格里只会念「表格」，说不清这
                是哪张表。上面那行 h2 不在表格的无障碍关系里（h2 只给 section 命名），
                所以要一份 caption。用 .sr-only 藏着：文案与紧邻的 h2 + 说明段重复，
                再显式渲染一遍是占位的噪声。口径按「牵头机关 / 全部收录历史」自包含地
                写清楚，读者从表格里跳出来也知道数字是什么。 */}
            <caption className="sr-only">
              各部门公示量：按牵头机关聚合的公示条目数，覆盖全部收录历史
            </caption>
            <thead>
              <tr>
                <th scope="col">发布机关</th>
                <th scope="col" className="stat-num">
                  公示量
                </th>
              </tr>
            </thead>
            <tbody>
              {agencyTotals.map((row: AgencyTotal) => {
                const href = agencyDrillHref(row.agency);
                const label = row.agency === '' ? '未标注机关' : row.agency;
                return (
                  <tr key={row.agency} data-testid="agency-total-row">
                    <th scope="row">
                      {/*
                        钻取链接（issue #36）：带 lead=1 走**牵头机关**口径 ——
                        与这张表的口径一致，所以「点进去的条数 = 表格上的数字」。
                        不带 lead 的话是「任一参与机关」（issue #21），联合发文会让
                        条数比表格多（实测发改委 25 → 26），看起来像统计出错。
                      */}
                      {href === null ? (
                        <span data-testid="agency-total-label">{label}</span>
                      ) : (
                        <Link
                          href={href}
                          data-testid="agency-total-link"
                          aria-label={`查看${label}牵头的 ${row.count} 条公示`}
                        >
                          {label}
                        </Link>
                      )}
                    </th>
                    <td className="stat-num">{row.count}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </section>

      <section className="stats-section" aria-labelledby="stats-trend-title">
        <h2 id="stats-trend-title">公示量月度趋势（最近 {TREND_MONTHS} 个月）</h2>
        <p className="section-hint">
          按发布日期所在月份统计（{months[0]} 至 {months[months.length - 1]}）。
          点格子里的数字可查看该机关该月发布的条目（条数与格子一致）；点月度合计可查看该月全部条目。
          小计与总计点进去是该区间（{months[0]} 至 {months[months.length - 1]}）的筛选结果
          —— 行小计按机关、总计按全部机关（issue #48）。
          {/* 0 值为什么点不开（issue #53）：数字在 0 时退化为纯文本是刻意的（点进去必然
              是空列表），但页面上没有任何说明，读者会以为链接坏了 */}
          数字为 0 的格子不可点击（点进去只会是空列表）。
        </p>
        {trendAgencies.length === 0 ? (
          <EmptyBlock
            testId="stats-trend-empty"
            text={`最近 ${TREND_MONTHS} 个月内暂无公示发布，趋势将随数据收录逐步呈现。`}
          />
        ) : (
          <div
            className="stat-table-wrap"
            data-testid="stat-table-wrap"
            role="region"
            tabIndex={0}
            aria-label="公示量月度趋势表（窄屏可横向滚动）"
          >
          <table className="stat-table" data-testid="trend-table">
            {/* 同上（issue #54）。这张表的口径和上面那张不一样（近 6 个月 × 按月、
                行小计是区间和），所以 caption 要把窗口与聚合方式一起说清，
                不能只写「月度趋势」。 */}
            <caption className="sr-only">
              公示量月度趋势：按发布月份聚合的公示条目数，窗口为 {months[0]} 至{' '}
              {months[months.length - 1]}
            </caption>
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
                  {months.map((month) => {
                    const count = series.byMonth.get(month) ?? 0;
                    return (
                      <td className="stat-num" key={month} data-month={month}>
                        <DrillNumber
                          count={count}
                          href={agencyDrillHref(agency, `&from=${month}&to=${month}`)}
                          testId="trend-cell-link"
                          label={`查看${agency} ${month} 发布的 ${count} 条公示`}
                        />
                      </td>
                    );
                  })}
                  <td className="stat-num stat-total">
                    <DrillNumber
                      count={series.total}
                      href={agencyDrillHref(agency, `&from=${months[0]}&to=${months[months.length - 1]}`)}
                      testId="trend-row-total-link"
                      label={`查看${agency}在 ${months[0]} 至 ${months[months.length - 1]} 发布的 ${series.total} 条公示`}
                    />
                  </td>
                </tr>
              ))}
              <tr data-testid="trend-total-row">
                <th scope="row">全部机关</th>
                {monthTotals.map((total, index) => (
                  <td className="stat-num stat-total" key={months[index]}>
                    {/* 用区间写法（from = to = 该月）而不是 `?month=`：issue #48 已把
                        `?month=` 定为只读兼容别名（老链接仍认），页面不该再产出它 */}
                    <DrillNumber
                      count={total}
                      href={`/?from=${months[index]}&to=${months[index]}`}
                      testId="trend-month-link"
                      label={`查看 ${months[index]} 发布的 ${total} 条公示`}
                    />
                  </td>
                ))}
                <td className="stat-num stat-total">
                  <DrillNumber
                    count={grandTotal}
                    href={`/?from=${months[0]}&to=${months[months.length - 1]}`}
                    testId="trend-grand-total-link"
                    label={`查看 ${months[0]} 至 ${months[months.length - 1]} 发布的 ${grandTotal} 条公示`}
                  />
                </td>
              </tr>
            </tbody>
          </table>
          </div>
        )}
      </section>

      <section className="stats-section" aria-labelledby="stats-period-title">
        <h2 id="stats-period-title">公示期长度分布</h2>
        <p className="section-hint">
          公示期长度 = 截止日期 - 发布日期（按日历日）；分桶为 7 天以内 / 8-15 天 / 16-30 天 /
          31 天及以上。
          {/* 只写规则不够：上方写着「收录 N 条」、四桶之和却是另一个数，读者无从判断差的
              那几条是被规则排除的、还是漏统计了。这里把差额按条数说出来（issue #46）。 */}
          {periodExcluded > 0
            ? `另有 ${periodExcluded} 条未标注截止日期（或发布日期），不参与统计 —— 四桶之和因此小于收录总数。`
            : '全部条目都已标注截止日期，四桶之和等于收录总数。'}
          {/* 与趋势表同一说明（issue #53）：0 条时计数退化为纯文本，页面要讲清楚 */}
          计数为 0 的桶不可点击。
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
                <span className="period-count">
                  <DrillNumber
                    count={bucket.count}
                    href={`/?period=${bucket.key}`}
                    testId="period-bucket-link"
                    label={`查看公示期${PERIOD_LABELS[bucket.key]}的 ${bucket.count} 条公示`}
                    text={`${bucket.count} 条`}
                  />
                </span>
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

      <SiteFooter note="统计数据全部来自本站收录的官方公开信息与站内跳转点击的纯计数聚合，不涉及任何个人身份信息。" />
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
