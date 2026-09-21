import Link from 'next/link';
import { countNoticesFiltered, listNoticesFiltered, listNoticeAgencies } from '@/db/repo/notices';
import { NoticeItem } from '@/app/_lib/notice-item';
import { SearchForm } from '@/app/_lib/search-form';
import { IcpFiling } from '@/app/_lib/icp-filing';
import { DOMAIN_CATEGORIES, isKnownCategory } from '@/lib/categories';
import { mailerReady } from '@/lib/mailer-availability';

// 数据随抓取管线持续更新，首页始终服务端实时渲染，不做静态预渲染。
export const dynamic = 'force-dynamic';

/**
 * 每页条数：默认 50，可用 LIST_PAGE_SIZE 覆盖（运维调参，无需重新构建）。
 *
 * 引入分页的原因（issue #19）：列表此前硬编码 50 条上限且无翻页 —— 源扩到 7 个后
 * 库内 125 条，首页只渲染前 50 条、其余 75 条从首页不可达，而「共 N 条」显示的还是
 * 本页条数（假的合计数）。现在合计取 count 查询的真实值，翻页链接保留全部筛选条件。
 */
function pageSize(): number {
  const raw = Number(process.env.LIST_PAGE_SIZE ?? '');
  return Number.isInteger(raw) && raw > 0 ? raw : 50;
}

interface HomePageProps {
  searchParams: Promise<{
    category?: string | string[];
    agency?: string | string[];
    q?: string | string[];
    lead?: string | string[];
    page?: string | string[];
  }>;
}

/** 取 querystring 参数首值并去空白；空串视为未筛选。 */
function firstParam(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** 取 querystring 里的页码：非正整数一律当作第 1 页（不报错、不空页）。 */
function pageParam(value: string | string[] | undefined): number {
  const parsed = Number(firstParam(value) ?? '1');
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

/** 当前生效的筛选状态（全部可分享于 querystring：/?category=…&agency=…&q=…&page=N）。 */
interface FilterState {
  category?: string;
  agency?: string;
  keyword?: string;
  /**
   * 机关筛选只算牵头机关（issue #36）：统计页的钻取链接带 `lead=1` 进来，
   * 与「各部门公示量」同一口径（联合发文只归牵头机关，否则各部门之和会超过总数）。
   * 从下拉框自己选的机关不带这个参数 —— 那时是「任一参与机关」（issue #21）。
   */
  leadAgencyOnly?: boolean;
  /** 页码；1 为默认，不写入链接（保持首页地址干净） */
  page?: number;
}

/**
 * 构造筛选 / 翻页链接（issue #9、#19）：普通链接 —— 点击即切换维度并保留其余
 * 筛选维度；目标维度传空串表示清除。纯 URL 驱动、零客户端 JS。
 * 切换筛选时页码归 1（换了条件还停在原页码会落到空页）。
 */
function buildFilterHref(current: FilterState, next: Partial<FilterState>): string {
  const merged = { ...current, ...next };
  const search = new URLSearchParams();
  if (merged.category) search.set('category', merged.category);
  if (merged.agency) search.set('agency', merged.agency);
  // lead 只在有机关筛选时才有意义（无机关时它不改变任何结果）
  if (merged.agency && merged.leadAgencyOnly) search.set('lead', '1');
  if (merged.keyword) search.set('q', merged.keyword);
  if (merged.page !== undefined && merged.page > 1) search.set('page', String(merged.page));
  const qs = search.toString();
  return qs.length > 0 ? `/?${qs}` : '/';
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const params = await searchParams;
  // 领域只接受已知标签值（未知值不生效，避免任意 querystring 触发无效筛选）
  const categoryParam = firstParam(params.category);
  const current: FilterState = {
    category: categoryParam && isKnownCategory(categoryParam) ? categoryParam : undefined,
    agency: firstParam(params.agency),
    keyword: firstParam(params.q),
    // 只有「带了机关 + lead=1」才算牵头口径；裸 lead=1 不改变任何结果
    leadAgencyOnly: firstParam(params.lead) === '1',
  };
  const { category, agency, keyword } = current;
  const hasFilter = category !== undefined || agency !== undefined || keyword !== undefined;

  const size = pageSize();
  // 页码先按请求值算偏移；总数拿到后再夹到有效范围（?page=999 落到末页而不是空页）
  const requestedPage = pageParam(params.page);
  const filter = { category, agency, keyword, leadAgencyOnly: current.leadAgencyOnly && agency !== undefined };

  // 仓库层排序：征求意见中在前、截止日期升序（即将截止在前）、无截止日期靠后；
  // 筛选（issue #9）只过滤行、不改变该顺序。合计与列表共用同一组筛选条件。
  const [total, agencies] = await Promise.all([
    countNoticesFiltered(filter),
    listNoticeAgencies(),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(requestedPage, totalPages);
  const notices = await listNoticesFiltered({
    ...filter,
    limit: size,
    offset: (page - 1) * size,
  });
  const rangeStart = total === 0 ? 0 : (page - 1) * size + 1;
  const rangeEnd = (page - 1) * size + notices.length;

  /**
   * 机关下拉的选项（issue #39）：当前筛选值若已不在库内机关列表里（issue #21 之前的下拉
   * 存的是「司法部、中国人民银行…」这种复合串，老链接仍在被分享），必须把它作为选项补进去 ——
   * 否则 <select> 的 defaultValue 匹配不到任何选项，浏览器会显示「全部机关」，
   * 而列表其实已经按该值筛选过了：筛选控件在说谎。
   * 补进来的选项放在最前，用户一眼能看到当前生效的是哪个值。
   */
  const agencyOptions =
    agency !== undefined && !agencies.includes(agency) ? [agency, ...agencies] : agencies;

  const filterSummary = [
    category,
    agency ? (current.leadAgencyOnly ? `机关（牵头）：${agency}` : `机关：${agency}`) : '',
    keyword ? `关键词：${keyword}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <main>
      <header className="site-header">
        <h1 className="brand">
          主人<span className="brand-accent">翁</span>
        </h1>
        <p className="tagline">政府公示与征求意见信息聚合 —— 发现 · 读懂 · 行动</p>
        {/* 站内搜索（issue #8）：GET 表单提交到 /search?q=…，不依赖客户端 JS */}
        <SearchForm />
        {/* 站内导航（issue #11）：数据统计页入口；订阅入口按邮件端口配置门控（issue #17） */}
        <nav className="site-nav" aria-label="站内导航">
          <a href="/stats" data-testid="stats-nav-link">
            数据统计
          </a>
          {mailerReady() ? (
            <a href="/subscribe" data-testid="subscribe-nav-link">
              订阅提醒
            </a>
          ) : null}
        </nav>
      </header>

      <section className="notice-section" aria-labelledby="notice-list-title">
        <h2 id="notice-list-title">最新公示</h2>
        <p className="section-hint">
          <span data-testid="filter-result-count">
            {hasFilter ? `筛选后共 ${total} 条（${filterSummary}）。` : `共 ${total} 条。`}
          </span>
          {totalPages > 1 && (
            <span data-testid="notice-range">
              {`当前第 ${page} / ${totalPages} 页（第 ${rangeStart}–${rangeEnd} 条）。`}
            </span>
          )}
          {/* 牵头口径说明（issue #36）：统计页钻取进来的窄口径要说清「为什么条数比参与口径少」，
              并给一键切回「任一参与机关」的入口 */}
          {filter.leadAgencyOnly ? (
            <span data-testid="lead-mode-hint">
              {`口径：只含${agency}牵头的条目（联合发文按牵头机关归并）。`}
              <Link
                className="search-back-link"
                href={buildFilterHref({ ...current, leadAgencyOnly: false }, {})}
                data-testid="lead-mode-switch"
              >
                改看含该机关参与的全部条目
              </Link>
            </span>
          ) : null}
          按征求意见截止日期排序，即将截止的排在最前。
          {/* RSS 订阅入口（issue #6）：页面可见入口，配合 head 内的自动发现链接 */}
          <a className="rss-link" href="/feed.xml" data-testid="rss-feed-link">
            RSS 订阅
          </a>
          {/* 邮件提醒入口（issue #17）：邮件端口可用时才出现，与 RSS 并列 */}
          {mailerReady() ? (
            <a className="rss-link" href="/subscribe" data-testid="subscribe-list-link">
              邮件提醒
            </a>
          ) : null}
        </p>

        {/* 分类浏览筛选条（issue #9）：领域标签云 + 机关下拉 + 关键词框，
            全部经 URL 参数驱动、服务端渲染，不依赖客户端 JS */}
        <div className="filter-bar" data-testid="notice-filter-bar" aria-label="公示筛选">
          <nav className="category-cloud" data-testid="category-filter" aria-label="按领域筛选">
            <a
              className={`category-chip${category === undefined ? ' category-chip-active' : ''}`}
              href={buildFilterHref(current, { category: '' })}
              data-testid="category-filter-all"
              aria-current={category === undefined ? 'true' : undefined}
            >
              全部领域
            </a>
            {DOMAIN_CATEGORIES.map((domain) => (
              <a
                key={domain.label}
                className={`category-chip${category === domain.label ? ' category-chip-active' : ''}`}
                href={buildFilterHref(current, { category: domain.label })}
                data-testid="category-filter-link"
                aria-current={category === domain.label ? 'true' : undefined}
              >
                {domain.label}
              </a>
            ))}
          </nav>
          {/* 机关下拉 + 关键词框共用一个 GET 表单；当前领域经隐藏字段保留 */}
          <form className="filter-form" action="/" method="get" data-testid="filter-form">
            {category !== undefined && <input type="hidden" name="category" value={category} />}
            <input
              className="filter-keyword"
              type="search"
              name="q"
              defaultValue={keyword ?? ''}
              placeholder="标题 / 正文关键词"
              aria-label="关键词过滤"
              data-testid="filter-keyword-input"
            />
            <select
              className="filter-agency"
              name="agency"
              aria-label="按发布机关筛选"
              data-testid="agency-filter-select"
              defaultValue={agency ?? ''}
            >
              <option value="">全部机关</option>
              {agencyOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <button className="filter-button" type="submit" data-testid="filter-submit">
              筛选
            </button>
            {hasFilter && (
              <Link className="filter-clear" href="/" data-testid="filter-clear">
                清除筛选
              </Link>
            )}
          </form>
        </div>

        {notices.length === 0 ? (
          <div className="empty-state" data-testid="notice-empty-state">
            <p className="empty-title">{hasFilter ? '没有符合筛选条件的公示' : '暂无公示条目'}</p>
            {hasFilter ? (
              <p className="empty-hint">
                试试放宽或更换筛选条件，或
                <Link className="search-back-link" href="/" data-testid="filter-clear-empty">
                  清除全部筛选
                </Link>
                查看全部条目。
              </p>
            ) : (
              <p className="empty-hint">
                数据管线尚未收录任何官方公示。抓取管线接入后，这里将按截止日期倒计时展示全国人大、
                各部委等渠道的最新征求意见稿。
              </p>
            )}
          </div>
        ) : (
          <ul className="notice-list">
            {notices.map((notice) => (
              <NoticeItem key={notice.id} notice={notice} />
            ))}
          </ul>
        )}

        {/* 分页（issue #19）：纯链接翻页，保留全部筛选条件；单页时不渲染 */}
        {totalPages > 1 && (
          <nav className="pagination" data-testid="notice-pagination" aria-label="公示翻页">
            {page > 1 ? (
              <Link
                className="pagination-link"
                href={buildFilterHref(current, { page: page - 1 })}
                data-testid="pagination-prev"
                rel="prev"
              >
                上一页
              </Link>
            ) : (
              <span className="pagination-disabled" data-testid="pagination-prev-disabled">
                上一页
              </span>
            )}
            <span className="pagination-status" data-testid="pagination-status">
              {`第 ${page} / ${totalPages} 页`}
            </span>
            {page < totalPages ? (
              <Link
                className="pagination-link"
                href={buildFilterHref(current, { page: page + 1 })}
                data-testid="pagination-next"
                rel="next"
              >
                下一页
              </Link>
            ) : (
              <span className="pagination-disabled" data-testid="pagination-next-disabled">
                下一页
              </span>
            )}
          </nav>
        )}
      </section>

      <footer className="site-footer">
        <p>
          本站只聚合官方公开信息并提供 AI 解读（AI 生成内容将显著标注），提交意见请一律前往官方渠道。
        </p>
        <IcpFiling />
      </footer>
    </main>
  );
}
