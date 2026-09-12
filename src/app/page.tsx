import Link from 'next/link';
import { listNoticesFiltered, listNoticeAgencies } from '@/db/repo/notices';
import { NoticeItem } from '@/app/_lib/notice-item';
import { SearchForm } from '@/app/_lib/search-form';
import { DOMAIN_CATEGORIES, isKnownCategory } from '@/lib/categories';

// 数据随抓取管线持续更新，首页始终服务端实时渲染，不做静态预渲染。
export const dynamic = 'force-dynamic';

interface HomePageProps {
  searchParams: Promise<{
    category?: string | string[];
    agency?: string | string[];
    q?: string | string[];
  }>;
}

/** 取 querystring 参数首值并去空白；空串视为未筛选。 */
function firstParam(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** 当前生效的筛选状态（全部可分享于 querystring：/?category=…&agency=…&q=…）。 */
interface FilterState {
  category?: string;
  agency?: string;
  keyword?: string;
}

/**
 * 构造筛选链接（issue #9）：标签云是普通链接 —— 点击即切换领域并保留其余
 * 筛选维度；目标维度传空串表示清除。纯 URL 驱动、零客户端 JS。
 */
function buildFilterHref(current: FilterState, next: Partial<FilterState>): string {
  const merged = { ...current, ...next };
  const search = new URLSearchParams();
  if (merged.category) search.set('category', merged.category);
  if (merged.agency) search.set('agency', merged.agency);
  if (merged.keyword) search.set('q', merged.keyword);
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
  };
  const { category, agency, keyword } = current;
  const hasFilter = category !== undefined || agency !== undefined || keyword !== undefined;

  // 仓库层排序：征求意见中在前、截止日期升序（即将截止在前）、无截止日期靠后；
  // 筛选（issue #9）只过滤行、不改变该顺序。
  const [notices, agencies] = await Promise.all([
    listNoticesFiltered({ category, agency, keyword, limit: 50 }),
    listNoticeAgencies(),
  ]);

  const filterSummary = [
    category,
    agency ? `机关：${agency}` : '',
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
        {/* 站内导航（issue #11）：数据统计页入口 */}
        <nav className="site-nav" aria-label="站内导航">
          <a href="/stats" data-testid="stats-nav-link">
            数据统计
          </a>
        </nav>
      </header>

      <section className="notice-section" aria-labelledby="notice-list-title">
        <h2 id="notice-list-title">最新公示</h2>
        <p className="section-hint">
          <span data-testid="filter-result-count">
            {hasFilter ? `筛选后共 ${notices.length} 条（${filterSummary}）。` : `共 ${notices.length} 条。`}
          </span>
          按征求意见截止日期排序，即将截止的排在最前。
          {/* RSS 订阅入口（issue #6）：页面可见入口，配合 head 内的自动发现链接 */}
          <a className="rss-link" href="/feed.xml" data-testid="rss-feed-link">
            RSS 订阅
          </a>
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
              {agencies.map((name) => (
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
      </section>

      <footer className="site-footer">
        <p>
          本站只聚合官方公开信息并提供 AI 解读（AI 生成内容将显著标注），提交意见请一律前往官方渠道。
        </p>
        <p>ICP 备案：待备案（占位）</p>
      </footer>
    </main>
  );
}
