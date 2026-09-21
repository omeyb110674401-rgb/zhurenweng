import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clientKeyOf, createRateLimiter } from '../../src/lib/rate-limit.ts';

/**
 * 限流器单测（issue #52）：注入时钟，不依赖真实时间。
 *
 * 这里要钉死的是三件事：窗口内到点就拒、窗口滚动后恢复、按 key 互不影响 ——
 * 前两条错了会把正常用户挡在门外（比不做限流更糟），第三条错了等于给全站共用一个桶。
 */

/** 可控时钟。 */
function fakeClock(start = 1_000_000) {
  let at = start;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}

describe('createRateLimiter：固定窗口', () => {
  it('窗口内超过阈值即拒，且给出剩余等待时间', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: clock.now });

    assert.equal(limiter.check('ip-1').allowed, true);
    assert.equal(limiter.check('ip-1').allowed, true);
    assert.equal(limiter.check('ip-1').allowed, true);

    const denied = limiter.check('ip-1');
    assert.equal(denied.allowed, false, '第 4 次应被拒');
    assert.equal(denied.retryAfterMs, 60_000, '剩余等待时间 = 窗口结束时刻 - 当前时刻');
  });

  it('窗口滚动后恢复放行（不是永久封禁）', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock.now });

    assert.equal(limiter.check('ip-1').allowed, true);
    assert.equal(limiter.check('ip-1').allowed, false);

    clock.advance(59_999);
    assert.equal(limiter.check('ip-1').allowed, false, '窗口内仍应拒');

    clock.advance(1);
    const afterWindow = limiter.check('ip-1');
    assert.equal(afterWindow.allowed, true, '窗口结束即恢复');
    assert.equal(afterWindow.retryAfterMs, 0);
  });

  it('按 key 隔离：一个 IP 被限不影响另一个', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock.now });

    assert.equal(limiter.check('ip-1').allowed, true);
    assert.equal(limiter.check('ip-1').allowed, false);
    assert.equal(limiter.check('ip-2').allowed, true, '另一个 IP 不该被连坐');
  });

  it('limit <= 0 表示不限流（不是「拒绝全部」）', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 0, windowMs: 60_000, now: clock.now });
    for (let i = 0; i < 100; i += 1) {
      assert.equal(limiter.check('ip-1').allowed, true);
    }
  });

  it('计数表变大后惰性清理不影响判定', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: clock.now });

    // 造出超过清理阈值的 key 数量（512），再把时钟推过窗口让它们全部过期
    for (let i = 0; i < 600; i += 1) limiter.check(`ip-${i}`);
    clock.advance(60_001);
    // 清理发生在下一次 check 时：清理后新 key 仍是「首次」
    assert.equal(limiter.check('ip-new').allowed, true);
    assert.equal(limiter.check('ip-new').allowed, true);
    assert.equal(limiter.check('ip-new').allowed, false, '清理不该把新 key 的计数也清掉');
  });
});

describe('clientKeyOf：取 X-Forwarded-For 第一跳', () => {
  it('多跳取第一个（Caddy 写在最前的是真实客户端）', () => {
    const request = new Request('https://zw.test/x', {
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 172.16.0.1' },
    });
    assert.equal(clientKeyOf(request), '203.0.113.9');
  });

  it('缺头 / 空值归到 unknown（直连场景分不出谁是谁）', () => {
    assert.equal(clientKeyOf(new Request('https://zw.test/x')), 'unknown');
    assert.equal(
      clientKeyOf(new Request('https://zw.test/x', { headers: { 'x-forwarded-for': '  ' } })),
      'unknown',
    );
  });
});
