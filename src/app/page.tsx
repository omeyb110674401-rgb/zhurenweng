import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  countNoticesFiltered,
  listNoticeSourceFacets,
  listNoticesFiltered,
  listNoticeAgencies,
  type NoticeSourceFacet,
} from '@/db/repo/notices';
import { NoticeItem } from '@/app/_lib/notice-item';
import { SearchForm } from '@/app/_lib/search-form';
import {
  describeHomeQuery,
  parseHomeQuery,
  subFeedHref,
  type HomeSearchParams,
} from '@/app/_lib/home-query';
import type { PeriodBucketKey } from '@/lib/notice-period';
import { NOTICE_SORT_KEYS, NOTICE_SORT_LABELS, type NoticeSortKey } from '@/lib/notice-sort';
import { SINCE_OPTION_DAYS } from '@/lib/notice-recency';
import { buildNoticeListJsonLd, serializeJsonLd } from '@/lib/notice-jsonld';
import { DOMAIN_CATEGORIES } from '@/lib/categories';
import { AUDIENCE_HINTS, AUDIENCE_LABELS, NOTICE_AUDIENCES, type NoticeAudience } from '@/lib/audience';
import { siteUrl } from '@/lib/site-url';
import { mailerReady } from '@/lib/mailer-availability';
import { SiteFooter } from '@/app/_lib/site-footer';

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
  searchParams: Promise<HomeSearchParams>;
}

/**
 * 列表页的索引口径（issue #41）。
 *
 * 首页的 querystring 空间是**无界**的：`?q=` 可以是任意字符串、`?agency=` 可以是
 * 任意机关名（含 issue #21 之前分享出去的复合串、以及随手敲的垃圾值 —— 它们都会
 * 渲染出一页「筛选后共 0 条」），再乘上领域 / 页码的组合。这些变体的标题与描述与
 * 首页完全相同、内容只是列表的子集 —— 收录它们等于往索引里灌薄页，并把真正有用的
 * 条目页稀释掉（与 `/search` 同一处理，见 issue #38）。
 *
 * 因此：**筛选视图 noindex（仍 follow，结果里的条目链接照常被发现）；分页视图是列表
 * 的不同切片、不是重复内容，保留可收录并给自指 canonical**（第 1 页指回根地址）。
 * 解析与渲染共用 `parseHomeQuery`，两处口径不会分叉。
 */
export async function generateMetadata({ searchParams }: HomePageProps): Promise<Metadata> {
  const query = parseHomeQuery(await searchParams);
  // 只带 lead=1 的地址渲染结果与首页完全相同（无机关时该参数不生效），也算参数变体
  if (query.hasFilter || query.leadAgencyOnly) {
    return { robots: { index: false, follow: true } };
  }
  const base = siteUrl();
  return {
    alternates: {
      // 子路由一旦导出 alternates，父级 layout 的同名字段就被整块覆盖 —— RSS 自动发现
      // （issue #6）必须在这里一并给出，否则首页会丢掉 head 里的 feed 链接
      // （既有 e2e「列表页含 RSS 自动发现」当场抓到了这个回归）。
      types: { 'application/rss+xml': '/feed.xml' },
      canonical: query.page > 1 ? `${base}/?page=${query.page}` : `${base}/`,
    },
  };
}

/** 当前生效的筛选状态（全部可分享于 querystring：/?category=…&agency=…&q=…&page=N）。 */
interface FilterState {
  category?: string;
  /**
   * 受众面（issue #83）：与领域正交的第二个维度 —— 领域答"关于什么事"，
   * 受众面答"该谁来看、该谁去提意见"（公众广域 / 行业专业 / 未判定）。
   */
  audience?: NoticeAudience;
  agency?: string;
  keyword?: string;
  /**
   * 发布月份区间（YYYY-MM，issue #48）：统计页「公示量月度趋势」表的钻取口径 ——
   * 月份格子是 from = to = 该月，行小计 / 总计是窗口起止月。
   * 与统计页聚合同口径（按**发布**月份分组），否则「点进去的条数 = 表格数字」不成立。
   */
  from?: string;
  to?: string;
  /**
   * 公示期分桶（issue #47）：统计页「公示期长度分布」的钻取口径。
   * 桶边界与文案统一在 lib/notice-period.ts，SQL 条件由同一份定义推导。
   */
  period?: PeriodBucketKey;
  /** 来源渠道 ID（issue #65）：统计页「各来源收录量」的钻取口径 */
  source?: string;
  /**
   * 机关筛选只算牵头机关（issue #36）：统计页的钻取链接带 `lead=1` 进来，
   * 与「各部门公示量」同一口径（联合发文只归牵头机关，否则各部门之和会超过总数）。
   * 从下拉框自己选的机关不带这个参数 —— 那时是「任一参与机关」（issue #21）。
   */
  leadAgencyOnly?: boolean;
  /**
   * 排序档位（issue #62）：`undefined` = 默认倒计时序，不写进链接（首页地址保持干净，
   * 也让所有既有的分享链接一字不差地照旧）。
   */
  sort?: NoticeSortKey;
  /** 只看还没截止的条目（issue #62） */
  openOnly?: boolean;
  /** 只看最近 N 天内首次收录的条目（issue #62） */
  sinceDays?: number;
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
  if (merged.audience) search.set('audience', merged.audience);
  if (merged.agency) search.set('agency', merged.agency);
  // lead 只在有机关筛选时才有意义（无机关时它不改变任何结果）
  if (merged.agency && merged.leadAgencyOnly) search.set('lead', '1');
  if (merged.keyword) search.set('q', merged.keyword);
  if (merged.from) search.set('from', merged.from);
  if (merged.to) search.set('to', merged.to);
  if (merged.period) search.set('period', merged.period);
  if (merged.source) search.set('source', merged.source);
  if (merged.sort) search.set('sort', merged.sort);
  if (merged.openOnly) search.set('open', '1');
  if (merged.sinceDays) search.set('since', String(merged.sinceDays));
  if (merged.page !== undefined && merged.page > 1) search.set('page', String(merged.page));
  const qs = search.toString();
  return qs.length > 0 ? `/?${qs}` : '/';
}

export default async function HomePage({ searchParams }: HomePageProps) {
  // 解析与 generateMetadata 共用同一份（issue #41）：领域只接受已知标签值
  // （未知值不生效，避免任意 querystring 触发无效筛选）
  const query = parseHomeQuery(await searchParams);
  const current: FilterState = {
    category: query.category,
    audience: query.audience,
    agency: query.agency,
    keyword: query.keyword,
    from: query.from,
    to: query.to,
    period: query.period,
    source: query.source,
    // 只有「带了机关 + lead=1」才算牵头口径；裸 lead=1 不改变任何结果
    leadAgencyOnly: query.leadAgencyOnly,
    sort: query.sort,
    openOnly: query.openOnly,
    sinceDays: query.sinceDays,
  };
  const { category, audience, agency, keyword, from, to, period, source } = current;
  const hasFilter = query.hasFilter;

  const size = pageSize();
  // 页码先按请求值算偏移；总数拿到后再夹到有效范围（?page=999 落到末页而不是空页）
  const requestedPage = query.page;
  const filter = {
    category,
    audience,
    agency,
    keyword,
    publishedFromMonth: from,
    publishedToMonth: to,
    periodBucket: period,
    sourceId: source,
    leadAgencyOnly: current.leadAgencyOnly && agency !== undefined,
    sort: query.sort,
    openOnly: query.openOnly,
    firstSeenWithinDays: query.sinceDays,
  };

  // 仓库层排序：征求意见中在前、截止日期升序（即将截止在前）、无截止日期靠后；
  // 筛选（issue #9）只过滤行、不改变该顺序。合计与列表共用同一组筛选条件。
  const [total, agencies, sourceFacets] = await Promise.all([
    countNoticesFiltered(filter),
    listNoticeAgencies(),
    // 来源下拉与统计页「各来源收录量」用同一个函数：两处数字不许分家（issue #36）
    listNoticeSourceFacets(),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(requestedPage, totalPages);
  // 越界页码归一（issue #53）：内容此前已经夹到末页，但地址栏与 canonical 还停在
  // ?page=999 —— 同一份内容对应多个地址，而 generateMetadata 按请求值发的
  // canonical 还会自指到一个越界地址（筛掉一页后 ?page=2 同理）。
  // 307 回夹取后的地址：临时重定向，不是「永久搬家」。
  if (requestedPage !== page) {
    redirect(buildFilterHref(current, { page }));
  }
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

  // 来源下拉的选项（issue #65，与上面 issue #39 那件事同一处理）
  const sourceOptions =
    source !== undefined && !sourceFacets.some((facet: NoticeSourceFacet) => facet.id === source)
      ? [{ id: source, name: source, registered: false, count: 0, openCount: 0, lastFirstSeenAt: null }, ...sourceFacets]
      : sourceFacets;

  // 来源显示的是登记表里的名字而不是 ID（这一行是给人读的口径说明）；
  // 登记表里查不到该 ID（源被删过）时退回 ID，条件不因此从说明里消失。
  const sourceName = source === undefined ? undefined : sourceFacets.find((facet: NoticeSourceFacet) => facet.id === source)?.name;
  const filterSummary = describeHomeQuery(query, sourceName);

  // 列表页结构化数据（issue #49）：描述**本页真实渲染**的那批条目，位置从本页首条起
  // 连续编号（分页时不会与上一页撞位）；numberOfItems 给整份列表的合计 `total`
  // （issue #54，见 lib/notice-jsonld.ts 的说明），与页面可见的「共 N 条」同口径。
  const listJsonLd = serializeJsonLd(
    buildNoticeListJsonLd({
      notices,
      siteUrl: siteUrl(),
      startPosition: (page - 1) * size + 1,
      totalItems: total,
    }),
  );

  return (
    <main id="main-content">
      {/* schema.org ItemList（issue #49）：给搜索引擎/聚合器读的机器可读清单；
          用户可见内容全在下方，此处不重复渲染 */}
      <script
        type="application/ld+json"
        data-testid="notice-list-jsonld"
        dangerouslySetInnerHTML={{ __html: listJsonLd }}
      />
      <header className="site-header">
        <h1 className="brand">
          主人<span className="brand-accent">翁</span>
        </h1>
        <p className="tagline">政府公示与征求意见信息聚合 —— 发现 · 读懂 · 行动</p>
        {/* 站内搜索（issue #8）：GET 表单提交到 /search?q=…，不依赖客户端 JS。
            回填当前列表关键词（issue #53）：筛选后头部框仍为空时，点它会带着空
            关键词跳到 /search 并把全部筛选条件丢掉，两处搜索框看起来像同一件事。 */}
        <SearchForm initialQuery={keyword ?? ''} />
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

      {/*
        列表页宽屏两栏（2026-10-02 用户拍板：一页的信息量不足）。
        窄屏 = 与改动前逐字一致的顺序：标题 → 合计 → 排序说明 → 排序/范围入口 →
        筛选条 → 列表 → 分页（筛选在列表**上方**，一个字都没挪）。
        宽屏（≥1000px，与详情页同一个断点）= 筛选条进右栏、列表占主栏。

        为什么 DOM 顺序**不动**、只靠栅格摆位：筛选条在文档里排在结果之前，于是
        键盘 Tab 与读屏的到达顺序在两种版式下都是"先筛选、后结果"。若改成把筛选条
        写在列表之后、再用 CSS 摆到左边，窄屏下筛选就跑到列表下面去了 —— 那正好
        违反"窄屏落回现在的样子"。CSS 的 `order` 也不做：那会让视觉顺序与焦点顺序
        分家（键盘用户 Tab 进一个"看起来在后面"的控件）。

        为什么 rail 放**右**：这一栏的内容就是改动前压在首屏、把列表顶到 2.5 条的那
        一整块（排序档 / 范围 / 受众面 / 领域 / 关键词 / 机关 / 来源 / 筛选按钮）。
        放在主栏右边 = 中文从左到右的阅读顺序仍是"先看列表、再看筛选"，与改动前
        "筛选在上、列表在下"的先后关系一致；同时整页左边缘（站点标题、搜索框、
        条目卡）对齐不动，只是右边多出一栏，视觉上不像换了一个站。
        `.list-page` 这个类只当"这是列表页"的标记用（`:has()` 的锚点），不承担宽度。
      */}
      <section className="notice-section list-page" aria-labelledby="notice-list-title">
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
        </p>

        {/* 排序说明与订阅入口单独成行（issue #53）：此前它们和条数、页码区间、牵头
            口径全挤在同一个段落里，窄屏下是一整块文字墙，RSS / 邮件提醒两个入口也
            读起来像正文的一部分。文案与 testid 一字未改，只换了容器。 */}
        <p className="list-actions">
          {/* 默认排序的文案保持原样（既有 e2e 与读者的既定印象都锚在这句上）；
              换档时才改口说当前是哪一档 —— 说明必须与页面真实的顺序一致 */}
          {current.sort === undefined
            ? '按征求意见截止日期排序，即将截止的排在最前。'
            : `按${NOTICE_SORT_LABELS[current.sort]}排序。`}
          {/* RSS 订阅入口（issue #6）：页面可见入口，配合 head 内的自动发现链接 */}
          <a className="rss-link" href="/feed.xml" data-testid="rss-feed-link">
            RSS 订阅
          </a>
          {/* 子 feed（issue #63）：筛选生效时才多给这一个入口 —— 订「只看未截止的生态环境」
              的人要的就是这一批条目，而全量 feed 会把条件整个丢掉。地址由 `subFeedHref`
              生成，与首页的筛选链接共用同一份参数口径。 */}
          {hasFilter ? (
            <a
              className="rss-link"
              href={subFeedHref(query)}
              data-testid="filtered-rss-link"
              title={`RSS 订阅当前条件：${filterSummary}`}
            >
              只订这一批（RSS）
            </a>
          ) : null}
          {/* 邮件提醒入口（issue #17）：邮件端口可用时才出现，与 RSS 并列 */}
          {mailerReady() ? (
            <a className="rss-link" href="/subscribe" data-testid="subscribe-list-link">
              邮件提醒
            </a>
          ) : null}
        </p>

        {/* 排序与收录范围入口（issue #62）：全是普通链接，切换时保留其余维度、页码归 1，
            与下方筛选条同一套「零客户端 JS」的做法 */}
        <nav className="view-controls" data-testid="view-controls" aria-label="排序与收录范围">
          <span className="view-controls-group">排序</span>
          {NOTICE_SORT_KEYS.map((key) => {
            const active = (current.sort ?? 'deadline') === key;
            return (
              <a
                key={key}
                className={`view-chip${active ? ' view-chip-active' : ''}`}
                href={buildFilterHref(current, { sort: key === 'deadline' ? undefined : key })}
                data-testid="sort-link"
                aria-current={active ? 'true' : undefined}
              >
                {NOTICE_SORT_LABELS[key]}
              </a>
            );
          })}
          <span className="view-controls-group">范围</span>
          <a
            className={`view-chip${current.openOnly ? ' view-chip-active' : ''}`}
            href={buildFilterHref(current, { openOnly: !current.openOnly })}
            data-testid="open-only-link"
            aria-current={current.openOnly ? 'true' : undefined}
          >
            只看未截止
          </a>
          {SINCE_OPTION_DAYS.map((days) => {
            const active = current.sinceDays === days;
            return (
              <a
                key={days}
                className={`view-chip${active ? ' view-chip-active' : ''}`}
                href={buildFilterHref(current, { sinceDays: active ? undefined : days })}
                data-testid="since-link"
                aria-current={active ? 'true' : undefined}
              >
                {`近 ${days} 天收录`}
              </a>
            );
          })}
        </nav>

        {/* 两栏栅格：窄屏是单列（筛选条在上、结果在下，与改动前逐字一致），
            ≥1000px 时筛选条进右栏、结果进主栏（列位全在 globals.css 的宽屏那一档）。
            这里只有两个直接子项（筛选条 / 结果区），中间不夹任何东西 ——
            栅格里的额外子项会各占一格，把"两栏"变成"三行"。 */}
        <div className="list-layout">
          {/* 分类浏览筛选条（issue #9）：领域标签云 + 机关下拉 + 关键词框，
              全部经 URL 参数驱动、服务端渲染，不依赖客户端 JS */}
          <div className="filter-bar" data-testid="notice-filter-bar">
            {/*
              受众面筛选条（issue #83）：与领域标签**正交**的第二个维度 ——
              领域答"这是关于什么事"，受众面答"该谁来看、该谁去提意见"。
              站长的原始诉求就是把「立法、税收这类影响面广的」与「林业、住房这类
              主要影响特定从业者的」分成两个大类；「未判定」也留在条上，因为
              筛出未判定的那批正是逐条改进规则（lib/audience.ts 的覆盖表）的入口。
            */}
            <nav className="audience-cloud" data-testid="audience-filter" aria-label="按受众面筛选">
              <span className="filter-group-label">受众面</span>
              <a
                className={`category-chip${audience === undefined ? ' category-chip-active' : ''}`}
                href={buildFilterHref(current, { audience: undefined })}
                data-testid="audience-filter-all"
                aria-current={audience === undefined ? 'true' : undefined}
              >
                全部
              </a>
              {NOTICE_AUDIENCES.map((key) => (
                <a
                  key={key}
                  className={`category-chip${audience === key ? ' category-chip-active' : ''}`}
                  href={buildFilterHref(current, { audience: audience === key ? undefined : key })}
                  data-testid="audience-filter-link"
                  data-audience={key}
                  title={AUDIENCE_HINTS[key]}
                  aria-current={audience === key ? 'true' : undefined}
                >
                  {AUDIENCE_LABELS[key]}
                </a>
              ))}
            </nav>
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
            {/* 机关下拉 + 关键词框共用一个 GET 表单；其余筛选维度经隐藏字段保留。
                表单名放在 <form> 上而不是外层 div（issue #53）：无 role 的 div 上的
                aria-label 多数辅助技术不会暴露，而带名字的 form 是真正的表单地标。 */}
            <form
              className="filter-form"
              action="/"
              method="get"
              data-testid="filter-form"
              aria-label="按机关与关键词筛选"
            >
              {category !== undefined && <input type="hidden" name="category" value={category} />}
              {/* 受众面也要留住（issue #83，与下面 sort / open / since 同一件事）：
                  表单里没这个字段时，用户只填个关键词点「筛选」就会静默丢掉刚选的受众面，
                  页面顶部却还显示着他筛过的那一档 */}
              {audience !== undefined && <input type="hidden" name="audience" value={audience} />}
              {from !== undefined && <input type="hidden" name="from" value={from} />}
              {to !== undefined && <input type="hidden" name="to" value={to} />}
              {period !== undefined && <input type="hidden" name="period" value={period} />}
              {source !== undefined && <input type="hidden" name="source" value={source} />}
              {/* 排序与范围同样要留住（issue #62，与 issue #50 的 lead 同一件事）：
                  表单里没这些字段时，用户只填个关键词点「筛选」就会静默回到默认排序 +
                  全部条目，页面顶部却还显示着他刚选的那一档 */}
              {current.sort !== undefined && (
                <input type="hidden" name="sort" value={current.sort} />
              )}
              {current.openOnly && <input type="hidden" name="open" value="1" />}
              {current.sinceDays !== undefined && (
                <input type="hidden" name="since" value={String(current.sinceDays)} />
              )}
              {/*
                牵头口径也要留住（issue #50）：从统计页钻取进来的是 `?agency=X&lead=1`
                （牵头机关，表格数字按它算），而表单此前只保留 category / from / to /
                period —— 用户不改机关、只填个关键词点「筛选」，lead=1 就静默丢失，
                口径退回「任一参与机关」，条数当场变化（发改委 25 → 26）。
                只在带机关时才写：裸 lead=1 不改变任何结果（见 buildFilterHref）。
              */}
              {current.leadAgencyOnly && agency !== undefined && (
                <input type="hidden" name="lead" value="1" />
              )}
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
              {/*
                来源下拉（issue #65）。与机关下拉同一处理（issue #39）：当前值若不在
                选项里（登记表里已删掉这个源，老链接还在被分享），把它补成第一项 ——
                否则 <select> 显示「全部来源」而列表其实按那个源筛过了，控件在说谎。
                选项是**有收录记录的 + 登记表里的**全部源（0 条的也在：那正是
                "源活着但不再送新东西"这种故障的可见化入口）。
              */}
              <select
                className="filter-source"
                name="source"
                aria-label="按来源渠道筛选"
                data-testid="source-filter-select"
                defaultValue={source ?? ''}
              >
                <option value="">全部来源</option>
                {sourceOptions.map((facet) => (
                  <option key={facet.id} value={facet.id}>
                    {facet.name}
                    {facet.count === 0 ? '（暂无收录）' : `（${facet.count}）`}
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

          {/* 结果区（主栏）：空态与列表二选一，后面跟着分页。
              它在栅格里是**第二个**子项 —— 宽屏落在主栏（第二列），窄屏落在筛选条之后 */}
          <div className="list-main">
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
                  <span
                    className="pagination-disabled"
                    data-testid="pagination-prev-disabled"
                    aria-disabled="true"
                  >
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
                  <span
                    className="pagination-disabled"
                    data-testid="pagination-next-disabled"
                    aria-disabled="true"
                  >
                    下一页
                  </span>
                )}
              </nav>
            )}
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
