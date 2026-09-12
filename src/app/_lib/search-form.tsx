/**
 * 站内搜索框（issue #8）：纯服务端渲染的 GET 表单，提交到 /search?q=…，
 * 不依赖客户端 JS。列表页头部与搜索结果页共用（结果页回填当前关键词）。
 */
export function SearchForm({ initialQuery = '' }: { initialQuery?: string }) {
  return (
    <form className="search-form" action="/search" method="get" role="search" data-testid="search-form">
      <input
        className="search-input"
        type="search"
        name="q"
        defaultValue={initialQuery}
        placeholder="搜索标题、摘要与正文关键词"
        aria-label="站内搜索"
      />
      <button className="search-button" type="submit">
        搜索
      </button>
    </form>
  );
}
