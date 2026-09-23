import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { envInt } from '../../src/lib/env-int.ts';
import {
  DEGRADED_MIN_LIST,
  isSourceDegraded,
  isSourceUnhealthy,
  shouldAlertForSourceFailure,
} from '../../src/lib/source-health.ts';

/**
 * 单元：「配置与判据」的守卫（issue #51 建立，issue #58 追加跨轮判据）。
 *
 * envInt：环境变量里的整数不能直接 Number() —— `Number('abc')` 是 NaN，而 NaN 会
 * 静默穿过大多数用法，把「配置写错」变成「看起来在跑的错误行为」：
 * - `setInterval(fn, NaN)` 的延迟按 0 处理 → worker 对十个政府站点变成热循环；
 * - `for (let i = 0; i <= NaN; i += 1)` 一次都不执行 → 摘要重试整个失效。
 *
 * isSourceDegraded：抓取对逐条失败是宽容的（不拖垮整源），但宽容必须配一个
 * 「过半失败就说话」的判据，否则源站改版时健康看板全绿、数据静默烂掉。
 */

/** 在给定环境变量下执行，结束后精确还原。 */
function withEnv(name, value, fn) {
  const saved = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    return fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

describe('envInt：环境变量整数解析', () => {
  it('未设置 / 空白 → 缺省值（compose 的 ${VAR:-} 会传空串）', () => {
    for (const value of [undefined, '', '   ']) {
      withEnv('ZW_TEST_INT', value, () => {
        assert.equal(envInt('ZW_TEST_INT', 42), 42, `${JSON.stringify(value)} 应走缺省`);
      });
    }
  });

  it('合法整数按原值返回', () => {
    withEnv('ZW_TEST_INT', '86400000', () => {
      assert.equal(envInt('ZW_TEST_INT', 60_000), 86_400_000);
    });
    withEnv('ZW_TEST_INT', '0', () => {
      assert.equal(envInt('ZW_TEST_INT', 5), 0, '0 是合法值（min 默认为 0）');
    });
  });

  it('非法值抛出明确错误，而不是变成 NaN 静默乱跑', () => {
    const bad = ['abc', '1.5', 'NaN', 'Infinity', '12px', '-1'];
    for (const value of bad) {
      withEnv('ZW_TEST_INT', value, () => {
        assert.throws(
          () => envInt('ZW_TEST_INT', 60_000),
          /不是合法整数/,
          `「${value}」应报错（NaN 会让 setInterval 变成热循环）`,
        );
      });
    }
  });

  it('min / max 边界生效（间隔类配置不接受 0 或负数）', () => {
    withEnv('ZW_TEST_INT', '999', () => {
      assert.throws(() => envInt('ZW_TEST_INT', 60_000, { min: 1000 }), /不是合法整数/);
    });
    withEnv('ZW_TEST_INT', '1000', () => {
      assert.equal(envInt('ZW_TEST_INT', 60_000, { min: 1000 }), 1000, '等于下界是合法的');
    });
    withEnv('ZW_TEST_INT', '11', () => {
      assert.throws(() => envInt('ZW_TEST_INT', 3, { max: 10 }), /不是合法整数/);
    });
  });
});

describe('isSourceDegraded：过半逐条失败才报', () => {
  it('过半失败且列表够长 → 降级', () => {
    assert.equal(isSourceDegraded(7, 7), true, '全部失败');
    assert.equal(isSourceDegraded(7, 4), true, '4/7 过半');
    assert.equal(isSourceDegraded(4, 2), true, '恰好一半');
    assert.equal(isSourceDegraded(DEGRADED_MIN_LIST, 2), true, '3 条里 2 条失败');
  });

  it('偶发失败不报（狼来了比漏报更伤告警信誉）', () => {
    assert.equal(isSourceDegraded(7, 3), false, '3/7 未过半');
    assert.equal(isSourceDegraded(178, 1), false, '一条抖动');
    assert.equal(isSourceDegraded(10, 0), false, '无失败');
  });

  it('列表太短不足以判断 → 不报', () => {
    assert.equal(isSourceDegraded(1, 1), false, '单条列表失败也不报');
    assert.equal(isSourceDegraded(2, 2), false, '两条列表失败也不报');
  });

  it('异常入参不报错也不误报', () => {
    assert.equal(isSourceDegraded(Number.NaN, 3), false);
    assert.equal(isSourceDegraded(7, Number.NaN), false);
    assert.equal(isSourceDegraded(7, -1), false);
  });
});

/**
 * issue #58 的第二根轴：跨轮连着坏了多久。与上面的 isSourceDegraded（一轮内坏多少）
 * 正交，两条判据各管一件事，别合并。
 */
describe('isSourceUnhealthy：连续失败满 2 轮才判红', () => {
  it('第 1 轮不算出事（抖动），第 2 轮起算', () => {
    assert.equal(isSourceUnhealthy(0), false);
    assert.equal(isSourceUnhealthy(1), false, '首轮失败只记不发：变红是第二轮的事');
    assert.equal(isSourceUnhealthy(2), true);
    assert.equal(isSourceUnhealthy(3), true);
    assert.equal(isSourceUnhealthy(99), true);
  });
});

describe('shouldAlertForSourceFailure：第 2 轮必发，之后每 7 轮封顶重发', () => {
  it('真出事当天必发', () => {
    assert.equal(shouldAlertForSourceFailure(1), false, '首轮抖动不发信');
    assert.equal(shouldAlertForSourceFailure(2), true, '第 2 轮是「真出事」的判定线，必须发');
  });

  it('持续故障按 7 轮重发，其余轮次静默', () => {
    const alerting = [];
    for (let n = 2; n <= 30; n += 1) {
      if (shouldAlertForSourceFailure(n)) alerting.push(n);
    }
    assert.deepEqual(alerting, [2, 9, 16, 23, 30], '第 2 轮之后每隔 7 轮一封');
  });

  it('坏着的源不会哑火（日历日去重之外还有一条重发线）', () => {
    assert.equal(shouldAlertForSourceFailure(9), true, '一直坏着就得继续说话');
    assert.equal(shouldAlertForSourceFailure(8), false, '但也不必每天一封');
  });

  it('异常入参不发信', () => {
    assert.equal(shouldAlertForSourceFailure(Number.NaN), false);
    assert.equal(shouldAlertForSourceFailure(-1), false);
  });
});
