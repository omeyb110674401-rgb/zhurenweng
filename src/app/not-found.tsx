import Link from 'next/link';
import { SearchForm } from '@/app/_lib/search-form';
import { SiteFooter } from '@/app/_lib/site-footer';

/**
 * 404 页（issue #17 前端审计）：Next 默认 404 是英文文案且没有任何回站入口，
 * 中文公众站点不该把用户扔在「This page could not be found.」上。
 * 这里给中文说明 + 站内检索 + 回列表入口，样式与其它页面一致。
 *
 * **必须逐请求渲染（issue #54）**：本页此前被构建期预渲染，于是页脚里两处**运行时**
 * 判断被固化成了构建期的值，线上实测出两个症状：
 * - `IcpFiling` 读 `process.env.ICP_NUMBER`（构建环境没有该变量）→ 404 页对外显示
 *   「ICP 备案：待备案（占位）」，而同域其它页显示真实备案号；
 * - `SiteFooter` 的 `mailerReady()` 在构建期取到默认的 `stub` → 404 页挂着「订阅提醒」
 *   入口，点进去是「暂未开放」，而其它页面按生产配置正确地隐藏了它。
 * 全站其它页面靠各自的 `force-dynamic` 避开了这个坑（见 `icp-filing.tsx` 的说明），
 * 但根 not-found 不在任何页面的路由段里，得自己声明。
 */
export const dynamic = 'force-dynamic';

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
