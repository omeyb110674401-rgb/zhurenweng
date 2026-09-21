import Link from 'next/link';
import { SearchForm } from '@/app/_lib/search-form';
import { SiteFooter } from '@/app/_lib/site-footer';

/**
 * 404 页（issue #17 前端审计）：Next 默认 404 是英文文案且没有任何回站入口，
 * 中文公众站点不该把用户扔在「This page could not be found.」上。
 * 这里给中文说明 + 站内检索 + 回列表入口，样式与其它页面一致。
 */
export default function NotFound() {
  return (
    <main id="main-content">
      <nav className="breadcrumb">
        <Link href="/">← 返回公示列表</Link>
      </nav>

      <header className="site-header">
        <h1 className="brand">没找到这个页面</h1>
        <p className="tagline">链接可能已失效，或这条公示尚未收录。</p>
        <SearchForm />
      </header>

      <section className="notice-section">
        <p className="section-hint">
          你可以
          <Link href="/">回到公示列表</Link>
          按领域浏览，或用
          <Link href="/feed.xml">RSS 订阅</Link>
          全部公示（新公示即时推送）。
        </p>
      </section>

      <SiteFooter />
    </main>
  );
}
