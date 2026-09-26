import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BOT_UA_PATTERN,
  SCRIPT_CLIENT_UA,
  notCountableReason,
} from '../../src/lib/outbound-counting.ts';

/**
 * 单元（issue #83）：北极星指标的门口 —— 哪些出站点击**不算数**。
 *
 * 为什么这一组值钱：`/go` 是北极星指标（出站提意点击数）的唯一入口，而机器遍历会把它
 * 灌成噪音。上线首日实测：45 条各 1 次点击、全部来自一次机器遍历（issue #17）。
 *
 * 为什么它以前没被自证覆盖：这段判据原先住在 `src/app/go/[id]/route.ts` 里，而 e2e 跑的是
 * `.next` 构建产物、pin 自证改的是源码 —— 撤掉实现，e2e 照样绿。抽成纯函数之后，
 * 判据第一次可以被"撤掉实现"真的验一遍（见 `scripts/check-test-pins.mjs` 的同名用例）。
 */

/** 造一个最小的 request 形状（判据只用到 method 与三个头）。 */
function request(method = 'GET', headers = {}) {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { method, headers: { get: (name) => lower.get(name.toLowerCase()) ?? null } };
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

describe('issue #83：出站点击该不该计入北极星指标', () => {
  it('真实浏览器的一次点击算数（这是唯一该计数的形状）', () => {
    assert.equal(notCountableReason(request('GET', { 'user-agent': BROWSER_UA })), null);
    assert.equal(
      notCountableReason(request('GET', { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1' })),
      null,
    );
  });

  it('空 UA 与脚本运行时 UA 都不算（爬虫遍历与自检请求）', () => {
    assert.match(notCountableReason(request('GET', {})), /空 UA/);
    for (const ua of ['curl/8.4.0', 'node', 'undici', 'python-requests/2.32.3', 'Go-http-client/1.1', 'axios/1.7.7']) {
      const reason = notCountableReason(request('GET', { 'user-agent': ua }));
      assert.ok(reason !== null && reason.startsWith('机器 UA'), `${ua} 不该计数，实际：${reason}`);
    }
    // 词表只认"恰好是脚本名"（可带版本号）：浏览器 UA 里出现 curl 字样时不该被误杀
    assert.equal(notCountableReason(request('GET', { 'user-agent': `Mozilla/5.0 curl/8.4.0 ${BROWSER_UA}` })), null);
    assert.equal(SCRIPT_CLIENT_UA.test(BROWSER_UA), false);
  });

  it('搜索引擎与 AI 爬虫都不算（含 GPTBot / ClaudeBot / Bytespider）', () => {
    for (const ua of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot',
      'ClaudeBot/1.0',
      'Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)',
      'Mozilla/5.0 (compatible; SemrushBot/7~bl)',
      'UptimeRobot/2.0',
    ]) {
      assert.ok(
        notCountableReason(request('GET', { 'user-agent': ua }))?.startsWith('机器 UA'),
        `${ua} 应判为机器`,
      );
    }
    assert.equal(BOT_UA_PATTERN.test(BROWSER_UA), false, '浏览器 UA 不该被机器词表命中');
  });

  it('HEAD 请求不算（`curl -I`、链接校验器、监控探针）', () => {
    assert.match(notCountableReason(request('HEAD', { 'user-agent': BROWSER_UA })), /HEAD/);
  });

  it('预取与预渲染不算（读者还没点，请求先来了）', () => {
    assert.match(
      notCountableReason(request('GET', { 'user-agent': BROWSER_UA, purpose: 'prefetch' })),
      /预取/,
    );
    assert.match(
      notCountableReason(request('GET', { 'user-agent': BROWSER_UA, 'sec-purpose': 'prerender' })),
      /预取/,
    );
    // 两个头任一命中即可（Chrome 走 Purpose，部分客户端走 Sec-Purpose）
    assert.match(
      notCountableReason(request('GET', { 'user-agent': BROWSER_UA, 'sec-purpose': 'prefetch;prerender' })),
      /预取/,
    );
  });

  it('判定的原因要写出来（事后查得到"这 45 次为什么没算"）', () => {
    const reason = notCountableReason(request('GET', { 'user-agent': 'GPTBot/1.2' }));
    assert.ok(reason !== null);
    assert.ok(reason.includes('GPTBot'), '原因里要带上那一串 UA（截断到 120 字）');
    const long = `${'x'.repeat(200)}bot`;
    assert.ok((notCountableReason(request('GET', { 'user-agent': long })) ?? '').length <= 130);
  });
});
