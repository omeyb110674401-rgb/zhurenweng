import type { NextConfig } from 'next';

/**
 * 安全响应头（issue #52）：此前**一处都没有** —— Caddyfile 只有 encode + reverse_proxy，
 * 本文件也没有 headers()。后果不只是「少几个头」：
 * - 无 HSTS 时浏览器在 `http://` 首跳会先把后台会话 Cookie（值即 ADMIN_TOKEN）发出去，
 *   Caddy 的 301 发生在之后；
 * - 无 X-Frame-Options 时后台页面（停用源、人工补录按钮）可被任意站点 iframe 点击劫持；
 * - 无 Referrer-Policy 时带 token 的地址（退订 / 确认页）能否外泄完全靠浏览器默认值。
 *
 * 放在这里而不是 Caddyfile：一处配置、能被 E2E 断言（tests/e2e/security-headers.test.mjs），
 * 也不必为了改头去动边缘配置。
 *
 * **刻意不做 CSP**：后台 HTML 用内联 `<style>`、Next 自身有内联引导脚本，严格 CSP 需要
 * nonce 体系，宽松 CSP（'unsafe-inline'）只是自我安慰。要做得单开一轮，已登记在
 * docs/pending-issues/FOLLOWUPS.md。
 *
 * **HSTS 不加 includeSubDomains / preload**：本站只有 www（已 301 到主域）一个子域，
 * preload 是不可撤回的长期承诺，收益不抵风险。将来要加，先确认没有 http-only 的子域。
 */
const SECURITY_HEADERS = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },

  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

/** 品牌资产（图标 / OG 图）：只在重新构建时变，但文件名不带 hash → 1 天。 */
const ONE_DAY = 'public, max-age=86400';

/** SEO 产物（robots / sitemap）：会变（新增条目即改收录面），但变得不快 → 1 小时。 */
const ONE_HOUR = 'public, max-age=3600';

/**
 * 静态与半静态资源的缓存头（issue #54）。
 *
 * 线上实测：`/_next/static/*` 是 `public, max-age=31536000, immutable`（正确 —— 文件名
 * 带 hash，内容一变名字就变，永不变质），但**根目录下**这些资源每次访问都回源
 * （`public, max-age=0, must-revalidate`）。本站没有 CDN、Caddy 只做 encode +
 * reverse_proxy（见 deploy/Caddyfile），所以「回源」就是真的打到 Node 进程上。
 *
 * TTL 取**适中**而不是一年：图标与 OG 图的内容只在重新构建时变，但文件名**不带 hash**，
 * 且 favicon.ico / apple-icon.png 的名字是规范固定的、改不了 —— 没有「换名即失效」这条
 * 退路，长 TTL 等于部署后旧图赖在用户盘上一年换不掉。1 天的代价是改版后最多一天内部分
 * 用户看到旧图标，可接受。
 *
 * robots.txt / sitemap.xml 给 1 小时还有个附带好处：sitemap 每次请求都要
 * `listAllNoticesForReindex()` **全表扫**一遍（无 limit，见 src/app/sitemap.ts），
 * 缓存把这个负担从「每个抓取请求一次」摊成「每小时一次」—— 而爬虫恰恰比人勤得多。
 *
 * **刻意不给任何 HTML 页面加缓存头**（这不是漏配）：本站没有 CDN、Caddy 也不开响应
 * 缓存，`s-maxage` 没有中间层会读，写了是空操作；而 `max-age` 作用在**浏览器私有缓存**
 * 上 —— 对一个「倒计时截止日期」站点，让用户看到过期的截止状态（页面说还剩 3 天、其实
 * 已截止）比省一次回源糟得多。真要上共享缓存，先按 docs/pending-issues/FOLLOWUPS.md
 * （#53「共享缓存 / CDN」那条）把页面里的实时计数解决掉。
 *
 * **`/feed.xml` 不在这张表里，保持它自己设的 `no-store`**：它是订阅者拉的实时数据源，
 * 缓存 feed 等于给订阅者推陈旧内容（issue #54 明确排除，别顺手补上）。
 */
const CACHE_HEADERS = [
  { source: '/favicon.ico', headers: [{ key: 'Cache-Control', value: ONE_DAY }] },
  { source: '/icon.svg', headers: [{ key: 'Cache-Control', value: ONE_DAY }] },
  { source: '/apple-icon.png', headers: [{ key: 'Cache-Control', value: ONE_DAY }] },
  { source: '/og-image.png', headers: [{ key: 'Cache-Control', value: ONE_DAY }] },
  { source: '/robots.txt', headers: [{ key: 'Cache-Control', value: ONE_HOUR }] },
  { source: '/sitemap.xml', headers: [{ key: 'Cache-Control', value: ONE_HOUR }] },
];

const nextConfig: NextConfig = {
  // better-sqlite3 是原生模块，drizzle-orm 的迁移器在运行时读取 SQL 文件，
  // nodemailer（SMTP 邮件适配器）依赖 CommonJS 动态加载，
  // 三者都不能被打包进服务端 bundle，必须作为外部依赖在运行时 require。
  serverExternalPackages: ['better-sqlite3', 'drizzle-orm', 'pg', 'nodemailer'],
  // 不回显框架与版本（默认发 X-Powered-By: Next.js）
  poweredByHeader: false,
  async headers() {
    // 安全头走 `/(.*)`（所有响应），缓存头按路径追加（issue #54）：两条规则源不同、
    // 键不冲突，Next 会合并 —— 加了缓存头的路径照样带全套安全头。
    return [{ source: '/(.*)', headers: SECURITY_HEADERS }, ...CACHE_HEADERS];
  },
};

export default nextConfig;
