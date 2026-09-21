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

const nextConfig: NextConfig = {
  // better-sqlite3 是原生模块，drizzle-orm 的迁移器在运行时读取 SQL 文件，
  // nodemailer（SMTP 邮件适配器）依赖 CommonJS 动态加载，
  // 三者都不能被打包进服务端 bundle，必须作为外部依赖在运行时 require。
  serverExternalPackages: ['better-sqlite3', 'drizzle-orm', 'pg', 'nodemailer'],
  // 不回显框架与版本（默认发 X-Powered-By: Next.js）
  poweredByHeader: false,
  async headers() {
    return [{ source: '/(.*)', headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
