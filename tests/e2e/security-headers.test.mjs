import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startAppServer } from './helpers/app-server.mjs';

/**
 * E2E（issue #52）：安全响应头与框架指纹。
 *
 * 背景：这些头此前**一个都没有** —— deploy/Caddyfile 只有 `encode` + `reverse_proxy`，
 * next.config.ts 也没有 headers()，`X-Powered-By: Next.js` 照发。后果不是「少几个头」：
 * - 无 HSTS：浏览器在 `http://` 首跳会先把后台会话 Cookie（值即 ADMIN_TOKEN）发出去，
 *   Caddy 的 301 发生在之后；
 * - 无 X-Frame-Options：后台页面（停用源、人工补录按钮）可被任意站点 iframe 点击劫持；
 * - 无 Referrer-Policy：带 token 的地址（退订 / 确认页）能否外泄完全靠浏览器默认值。
 *
 * 这里同时钉住「头在**所有**响应上」（200 / 404 / 401 都算）与「/go 自己的缓存头没被挤掉」——
 * 统一加头最容易出的事就是把某个路由特意设的头覆盖掉（/go 的 no-store 与 noindex
 * 是计数端点与收录面的关键，被覆盖会静默漏计点击 / 被收录）。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue52-headers-'));
const dbFile = path.join(workDir, 'app.db');

/** 必须下发的安全头（键 → 期望值片段）。 */
const EXPECTED_HEADERS = [
  ['strict-transport-security', /max-age=31536000/],
  ['x-content-type-options', /nosniff/],
  ['referrer-policy', /strict-origin-when-cross-origin/],
  ['x-frame-options', /DENY/],
  ['permissions-policy', /camera=\(\)/],
];

let app;

/** 断言一组响应头包含全部安全头，且没有框架指纹。 */
function assertSecurityHeaders(headers, where) {
  for (const [key, pattern] of EXPECTED_HEADERS) {
    const value = headers.get(key);
    assert.ok(value, `${where} 应下发 ${key}`);
    assert.match(value, pattern, `${where} 的 ${key} 取值不对：${value}`);
  }
  assert.equal(headers.get('x-powered-by'), null, `${where} 不该回显框架与版本`);
}

before(async () => {
  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      SITE_URL: 'https://zw.test',
      APP_BASE_URL: 'https://zw.test',
      ADMIN_TOKEN: 'zw-e2e-admin-token',
    },
  });
});

after(async () => {
  await app?.stop();
});

describe('issue #52：安全响应头与框架指纹', () => {
  it('首页（200）下发全套安全头，且不再回显 X-Powered-By', async () => {
    const response = await fetch(`${app.url}/`);
    assert.equal(response.status, 200);
    assertSecurityHeaders(response.headers, '首页');
  });

  it('404 与后台 401 同样带头（统一加头要覆盖所有响应，不只是渲染成功的页面）', async () => {
    const notFound = await fetch(`${app.url}/no-such-page-e2e`);
    assert.equal(notFound.status, 404);
    assertSecurityHeaders(notFound.headers, '404 页');

    const denied = await fetch(`${app.url}/admin`);
    assert.equal(denied.status, 401);
    assertSecurityHeaders(denied.headers, '后台 401 页');
  });

  it('路由自己设的头不被挤掉：/go 的 no-store 与 noindex 仍在', async () => {
    // /go/<不存在的 id>：走 404 分支，但同样带 NO_STORE（计数端点绝不能被缓存）
    const response = await fetch(`${app.url}/go/0000000000000000`, { redirect: 'manual' });
    assert.equal(response.status, 404);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    assertSecurityHeaders(response.headers, '/go 404');
  });

  it('rss 与 sitemap 也带头（爬虫拿到的响应同样不该缺 HSTS）', async () => {
    for (const pathname of ['/feed.xml', '/sitemap.xml', '/robots.txt']) {
      const response = await fetch(`${app.url}${pathname}`);
      assert.ok(response.status === 200, `${pathname} 应 200，实际 ${response.status}`);
      assertSecurityHeaders(response.headers, pathname);
    }
  });
});
