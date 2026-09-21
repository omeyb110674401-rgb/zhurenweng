import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startAppServer } from './helpers/app-server.mjs';

/**
 * E2E（issue #52）：匿名可达端点的限流。
 *
 * 为什么值得一个专门的文件：`POST /api/subscriptions` 是**匿名可达且会真的发信**的端点，
 * 此前一处限流都没有 —— 任何人对任意邮箱反复提交，本站就成了一台以自己域名发信的
 * 放大器（发信域声誉一旦进黑名单，连正常确认信都投不出去）。后台登录同理：共享密钥
 * 可被无限次在线爆破，且失败没有任何信号。
 *
 * 阈值走环境变量注入（本文件设成 2），所以既能验证「到点就拒」，又不会让别的
 * 测试文件（它们提交 5 次以上）被误伤 —— 阈值是旋钮，不是写死的常数。
 * 计数在进程内存里、按客户端 IP：本文件用 X-Forwarded-For 显式区分两个「客户端」，
 * 顺带验证了「一个 IP 被限不连坐另一个」。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue52-ratelimit-'));
const dbFile = path.join(workDir, 'app.db');
const outboxFile = path.join(workDir, 'outbox.jsonl');

const ADMIN_TOKEN = 'zw-e2e-admin-token';
const IP_A = '203.0.113.9';
const IP_B = '203.0.113.10';
const LIMIT = 2;

let app;

/** 读取 stub 邮件 outbox（JSONL）。 */
function readOutbox() {
  if (!fs.existsSync(outboxFile)) return [];
  return fs
    .readFileSync(outboxFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/** 提交订阅（可选指定客户端 IP）。 */
function postSubscription(email, ip) {
  const body = new URLSearchParams({ email, keywords: '噪声污染防治' });
  return fetch(`${app.url}/api/subscriptions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(ip ? { 'x-forwarded-for': ip } : {}),
    },
    body,
    redirect: 'manual',
  });
}

/** 尝试登录（可选指定客户端 IP）。 */
function postLogin(token, ip) {
  return fetch(`${app.url}/admin/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(ip ? { 'x-forwarded-for': ip } : {}),
    },
    body: new URLSearchParams({ token }),
    redirect: 'manual',
  });
}

before(async () => {
  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      MAILER_OUTBOX_FILE: outboxFile,
      SITE_URL: 'https://zw.test',
      APP_BASE_URL: 'https://zw.test',
      ADMIN_TOKEN,
      SUBSCRIBE_RATE_LIMIT_PER_HOUR: String(LIMIT),
      ADMIN_LOGIN_RATE_LIMIT_PER_HOUR: String(LIMIT),
    },
  });
});

after(async () => {
  await app?.stop();
});

describe('issue #52：订阅与登录限流', () => {
  it('订阅：阈值内正常受理，超限回 rate_limited 且不再发信', async () => {
    for (let i = 1; i <= LIMIT; i += 1) {
      const response = await postSubscription(`rl-${i}@example.com`, IP_A);
      assert.equal(response.status, 303);
      assert.match(
        response.headers.get('location') ?? '',
        /sent=1/,
        `第 ${i} 次应正常受理（阈值 ${LIMIT}）`,
      );
    }
    assert.equal(readOutbox().length, LIMIT, `阈值内应发出 ${LIMIT} 封确认邮件`);

    const limited = await postSubscription('rl-over@example.com', IP_A);
    assert.equal(limited.status, 303);
    assert.match(limited.headers.get('location') ?? '', /error=rate_limited/);

    // 关键：超限的那次**没有发信**（否则限流只挡住了响应，没挡住滥用）
    assert.equal(readOutbox().length, LIMIT, '超限请求不得发信');
    // 落库也一并挡住（不留下永远收不到确认邮件的待确认订阅）
    const page = await (await fetch(`${app.url}/subscribe?error=rate_limited`)).text();
    assert.match(page, /提交过于频繁/);
  });

  it('限流按客户端隔离：另一个 IP 不受影响', async () => {
    const response = await postSubscription('rl-other@example.com', IP_B);
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /sent=1/);
    assert.equal(readOutbox().length, LIMIT + 1, '另一个 IP 应被放行');
  });

  it('后台登录：阈值内 401（令牌不对），超限 429 且文案与「令牌错」区分开', async () => {
    for (let i = 1; i <= LIMIT; i += 1) {
      const response = await postLogin('wrong-token', IP_A);
      assert.equal(response.status, 401, `第 ${i} 次应是 401 而非限流`);
    }

    const limited = await postLogin('wrong-token', IP_A);
    assert.equal(limited.status, 429, '超限应回 429');
    const html = await limited.text();
    assert.match(html, /data-testid="admin-login-rate-limited"/);
    assert.ok(
      !html.includes('data-testid="admin-login-error"'),
      '限流文案不能与「令牌不匹配」混在一起（否则站长会以为自己的令牌错了）',
    );

    // 另一个 IP 仍可正常登录（正确的令牌 → 303 + 会话）
    const ok = await postLogin(ADMIN_TOKEN, IP_B);
    assert.equal(ok.status, 303);
    assert.match(ok.headers.get('location') ?? '', /^\/admin/);
  });
});
