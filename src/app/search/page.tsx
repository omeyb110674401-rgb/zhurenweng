import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getNoticesByIds } from '@/db/repo/notices';
import { createSearchPort } from '@/lib/ports';
import { hasSearchableQuery } from '@/lib/search/search-text';
import { NoticeItem } from '@/app/_lib/notice-item';
import { SearchForm } from '@/app/_lib/search-form';
import { SiteFooter } from '@/app/_lib/site-footer';

/**
 * 不进索引（issue #38）：搜索结果页的 URL 是 `?q=…` 的无界变体（每个关键词一个地址），
 * 内容随查询变化且高度重复，收录它等于往索引里灌薄页。
 *
 * 可发现性审计发现：全站没有任何 robots meta，而 robots.txt 只挡了 /admin、/go/、/api/ ——
 * 搜索结果页因此是可收录的，且它出现在每个页面的头部表单里（爬虫必然发现）。
 * `follow: true` 保留链接发现：爬虫仍会顺着结果里的条目链接抓到正文页。
 */
export const metadata: Metadata = { robots: { index: false, follow: true } };

// 搜索结果随索引持续更新，服务端实时渲染，不做静态预渲染。
export const dynamic = 'force-dynamic';

/**
 * 结果页每页条数：默认 50，可用 SEARCH_PAGE_SIZE 覆盖（运维调参，无需重新构建）。
 *
 * 为什么结果页必须分页（issue #31）：此前结果页把「本页条数」当总数显示、且硬编码
 * 单页 50 条 —— 线上搜「征求意见」实际命中 176 条，页面却写「共 50 条」，第 50 条
 * 之后的 126 条**从搜索完全不可达**。这与首页 issue #19 修掉的是同一类缺陷
 * （把截断结果当全量），搜索页当时漏了。
 */
function pageSize(): number {
  const raw = Number(process.env.SEARCH_PAGE_SIZE ?? '');
  return Number.isInteger(raw) && raw > 0 ? raw : 50;
}

interface SearchPageProps {
  searchParams: Promise<{ q?: string | string[]; page?: string | string[] }>;
}

/** 取 querystring 参数首值并去空白。 */
function firstParam(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim() ?? '';
}

/** 取页码：非正整数一律当作第 1 页（不报错、不空页）。 */
function pageParam(value: string | string[] | undefined): number {
  const parsed = Number(firstParam(value) || '1');
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

/** 构造结果页链接（翻页时保留关键词）。 */
function searchHref(query: string, page: number): string {
  const search = new URLSearchParams({ q: query });
  if (page > 1) search.set('page', String(page));
  return `/search?${search.toString()}`;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const params = await searchParams;
  const query = firstParam(params.q);

  // q 为空（未带关键词直接访问 /search）回到列表页
  if (query === '') {
    redirect('/');
  }

  const perPage = pageSize();
  const requestedPage = pageParam(params.page);
  // 无词元查询（纯标点 / 空白）：说清楚「该输什么」，而不是拿一个空结果页或全库结果搪塞
  // （issue #32：生产 Meilisearch 会把整库当命中返回 178 条）
  const searchable = hasSearchableQuery(query);

  // 检索失败（如生产 Meilisearch 不可达）渲染错误态，不让页面 500
  let total = 0;
  let hits: { id: string; title: string }[] = [];
  let searchFailed = false;
  try {
    const port = createSearchPort();
    let result = await port.search(query, { page: requestedPage, perPage });
    // 越界页回落到末页而不是空页（?page=999）：总数只有查过一次才知道，
    // 因此这里补一次查询 —— 仅在越界这一种情况下发生
    const totalPages = Math.max(1, Math.ceil(result.total / perPage));
    if (result.hits.length === 0 && result.total > 0 && requestedPage > totalPages) {
      result = await port.search(query, { page: totalPages, perPage });
    }
    total = result.total;
    hits = result.hits;
  } catch {
    searchFailed = true;
  }

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(requestedPage, totalPages);
  const rangeStart = total === 0 ? 0 : (page - 1) * perPage + 1;
  const rangeEnd = (page - 1) * perPage + hits.length;

  // 按检索相关性顺序渲染完整条目（getNoticesByIds 保持传入顺序，孤儿 id 跳过）
  const notices = await getNoticesByIds(hits.map((hit) => hit.id));

  return (
    <main id="main-content">
      {/* 面包屑此前写在 <header> 里、且是 <p>（issue #53）：全站其它页都是
          header 之外的 <nav class="breadcrumb">，只有这一页既不是导航地标、
          位置也不一致 */}
      <nav className="breadcrumb">
        <Link href="/">← 返回公示列表</Link>
      </nav>

      <header className="site-header">
        {/* 全站唯一没有 h1 的页面（issue #53）：标题层级直接从 h2 起，
            读屏用户与搜索引擎都拿不到「这一页是什么」 */}
        <h1 className="brand">站内搜索</h1>
        <SearchForm initialQuery={query} />
      </header>

      <section className="notice-section" aria-labelledby="search-results-title">
        <h2 id="search-results-title">
          「<span data-testid="search-query-text">{query}</span>」的搜索结果
        </h2>
        <p className="section-hint" data-testid="search-result-count">
          {searchFailed
            ? '搜索服务暂时不可用。'
            : `共 ${total} 条${total > 0 ? '，按相关度排序' : ''}`}
        </p>
        {!searchFailed && totalPages > 1 && (
          <p className="section-hint" data-testid="search-range">
            {`当前第 ${page} / ${totalPages} 页（第 ${rangeStart}–${rangeEnd} 条）。`}
          </p>
        )}

        {searchFailed ? (
          <div className="empty-state" data-testid="search-error-state">
            <p className="empty-title">搜索服务暂时不可用</p>
            <p className="empty-hint">
              请稍后重试，或
              <Link className="search-back-link" href="/">
                返回公示列表
              </Link>
              浏览全部条目。
            </p>
          </div>
        ) : !searchable ? (
          <div className="empty-state" data-testid="search-unusable-query">
            <p className="empty-title">「{query}」里没有可检索的字符</p>
            <p className="empty-hint">
              请输入至少一个汉字、字母或数字（如「医疗保障」「征求意见」「App」），或
              <Link className="search-back-link" href="/">
                返回公示列表
              </Link>
              浏览全部条目。
            </p>
          </div>
        ) : notices.length === 0 ? (
          <div className="empty-state" data-testid="search-empty-state">
            <p className="empty-title">没有找到与「{query}」相关的公示</p>
            <p className="empty-hint">
              试试更短的关键词（如「医疗保障」「征求意见」），或
              <Link className="search-back-link" href="/">
                返回公示列表
              </Link>
              浏览全部条目。
            </p>
          </div>
        ) : (
          <ul className="notice-list">
            {notices.map((notice) => (
              <NoticeItem key={notice.id} notice={notice} />
            ))}
          </ul>
        )}

        {/* 翻页（issue #31）：纯链接翻页、保留关键词；单页时不渲染 */}
        {!searchFailed && totalPages > 1 && (
          <nav className="pagination" data-testid="search-pagination" aria-label="搜索结果翻页">
            {page > 1 ? (
              <Link
                className="pagination-link"
                href={searchHref(query, page - 1)}
                data-testid="search-pagination-prev"
                rel="prev"
              >
                上一页
              </Link>
            ) : (
              <span
                className="pagination-disabled"
                data-testid="search-pagination-prev-disabled"
                aria-disabled="true"
              >
                上一页
              </span>
            )}
            <span className="pagination-status" data-testid="search-pagination-status">
              {`第 ${page} / ${totalPages} 页`}
            </span>
            {page < totalPages ? (
              <Link
                className="pagination-link"
                href={searchHref(query, page + 1)}
                data-testid="search-pagination-next"
                rel="next"
              >
                下一页
              </Link>
            ) : (
              <span
                className="pagination-disabled"
                data-testid="search-pagination-next-disabled"
                aria-disabled="true"
              >
                下一页
              </span>
            )}
          </nav>
        )}
      </section>

      <SiteFooter />
    </main>
  );
}
