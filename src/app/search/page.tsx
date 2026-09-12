import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getNoticesByIds } from '@/db/repo/notices';
import { createSearchPort, type SearchHit } from '@/lib/ports';
import { NoticeItem } from '@/app/_lib/notice-item';
import { SearchForm } from '@/app/_lib/search-form';

// 搜索结果随索引持续更新，服务端实时渲染，不做静态预渲染。
export const dynamic = 'force-dynamic';

/** 结果页一次最多返回的条目数（收录量级小，一页足够） */
const SEARCH_RESULTS_LIMIT = 50;

interface SearchPageProps {
  searchParams: Promise<{ q?: string | string[] }>;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const params = await searchParams;
  const raw = params.q;
  const query = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';

  // q 为空（未带关键词直接访问 /search）回到列表页
  if (query === '') {
    redirect('/');
  }

  // 检索失败（如生产 Meilisearch 不可达）渲染错误态，不让页面 500
  let hits: SearchHit[] = [];
  let searchFailed = false;
  try {
    hits = await createSearchPort().search(query, SEARCH_RESULTS_LIMIT);
  } catch {
    searchFailed = true;
  }
  // 按检索相关性顺序渲染完整条目（getNoticesByIds 保持传入顺序，孤儿 id 跳过）
  const notices = await getNoticesByIds(hits.map((hit) => hit.id));

  return (
    <main>
      <header className="site-header">
        <p className="breadcrumb">
          <Link href="/">← 返回公示列表</Link>
        </p>
        <SearchForm initialQuery={query} />
      </header>

      <section className="notice-section" aria-labelledby="search-results-title">
        <h2 id="search-results-title">
          「<span data-testid="search-query-text">{query}</span>」的搜索结果
        </h2>
        <p className="section-hint" data-testid="search-result-count">
          {searchFailed
            ? '搜索服务暂时不可用。'
            : `共 ${notices.length} 条${notices.length > 0 ? '，按相关度排序' : ''}`}
        </p>

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
