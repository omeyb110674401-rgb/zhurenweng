/**
 * 站点对外地址（robots.txt / sitemap.xml / 页面 canonical 与分享元数据用）：
 * 读 `SITE_URL` 环境变量，未配置时退回本地开发地址 —— 与 feed.xml（issue #6）
 * 的取值口径一致；订阅邮件里的链接走 `APP_BASE_URL`（见 lib/mail.ts），两者各司其职。
 *
 * 生产由 compose 注入 `SITE_URL=${SITE_URL:-}`（须为 https 且与 DOMAIN 一致）。
 */
export function siteUrl(): string {
  return (process.env.SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}
