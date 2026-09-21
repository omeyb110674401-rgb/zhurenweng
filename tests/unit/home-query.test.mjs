import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  firstParam,
  monthParam,
  monthRangeParam,
  pageParam,
  parseHomeQuery,
  periodParam,
} from '../../src/app/_lib/home-query.ts';

/**
 * 单元：首页 querystring 解析（issue #41）。
 *
 * 这份解析现在由**页面渲染与 generateMetadata 共用** —— 它同时决定「筛选后共 N 条」
 * 的文案、翻页链接，以及这一页要不要 noindex。抽出来之前两处各写一份，迟早分叉
 * （issue #32/#33 的教训：同一个口径有两份实现，最后给出相反答案）。这里钉死边界：
 * 空串 / 数组 / 非正整数页码 / 未知领域值。
 */

describe('firstParam：querystring 首值', () => {
  it('数组取首值、去空白、空串视为未传', () => {
    assert.equal(firstParam(['a', 'b']), 'a');
    assert.equal(firstParam('  x  '), 'x');
    assert.equal(firstParam(''), undefined);
    assert.equal(firstParam('   '), undefined);
    assert.equal(firstParam(undefined), undefined);
  });
});

describe('pageParam：页码', () => {
  it('正整数照用，数组取首值', () => {
    assert.equal(pageParam('1'), 1);
    assert.equal(pageParam('2'), 2);
    assert.equal(pageParam('999'), 999);
    assert.equal(pageParam(['3', '4']), 3);
  });

  it('非正整数 / 非数字一律回落第 1 页（不报错、不空页）', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '', '   ', undefined]) {
      assert.equal(pageParam(bad), 1, `page=${JSON.stringify(bad)} 应回落第 1 页`);
    }
  });
});

describe('monthParam：发布月份（issue #45）', () => {
  it('接受 YYYY-MM，补零必需（2026-8 不是合法月份值）', () => {
    assert.equal(monthParam('2026-08'), '2026-08');
    assert.equal(monthParam('2026-01'), '2026-01');
    assert.equal(monthParam('2026-12'), '2026-12');
    assert.equal(monthParam(' 2026-09 '), '2026-09', '去空白后仍合法');
  });

  it('非法值一律不生效（与未知领域值同一处理，不报错、不空页）', () => {
    for (const bad of ['2026-13', '2026-00', '2026-8', '26-08', '2026-08-01', '2026', 'abc', '%', '2026-%', '', '   ', undefined]) {
      assert.equal(monthParam(bad), undefined, `month=${JSON.stringify(bad)} 应不生效`);
    }
  });
});

describe('monthRangeParam：发布月份区间（issue #48）', () => {
  it('两端合法 → 原样返回；只给一端也有效', () => {
    assert.deepEqual(monthRangeParam('2026-04', '2026-09'), { from: '2026-04', to: '2026-09' });
    assert.deepEqual(monthRangeParam('2026-04', undefined), { from: '2026-04', to: undefined });
    assert.deepEqual(monthRangeParam(undefined, '2026-09'), { from: undefined, to: '2026-09' });
    assert.deepEqual(monthRangeParam(undefined, undefined), { from: undefined, to: undefined });
  });

  it('from > to → 两端都不生效（宁可不筛，也不给一页假空态）', () => {
    assert.deepEqual(monthRangeParam('2026-09', '2026-04'), {});
  });

  it('格式非法的一端不生效，另一端照常', () => {
    assert.deepEqual(monthRangeParam('2026-13', '2026-09'), { from: undefined, to: '2026-09' });
    assert.deepEqual(monthRangeParam('2026-04', 'abc'), { from: '2026-04', to: undefined });
  });
});

describe('periodParam：公示期分桶（issue #47）', () => {
  it('只认 notice-period.ts 定义过的桶 key', () => {
    for (const key of ['lte7', 'b8_15', 'b16_30', 'gt30']) {
      assert.equal(periodParam(key), key);
    }
  });

  it('非法值一律不生效（与未知领域值同一处理）', () => {
    for (const bad of ['lte8', 'gt31', '7', 'LTE7', 'b8-15', 'unknown', '', '   ', undefined]) {
      assert.equal(periodParam(bad), undefined, `period=${JSON.stringify(bad)} 应不生效`);
    }
  });
});

describe('parseHomeQuery：筛选状态与索引口径', () => {
  it('未知领域值不生效（避免任意 querystring 触发无效筛选）', () => {
    assert.equal(parseHomeQuery({ category: '生态环境' }).category, '生态环境');
    assert.equal(parseHomeQuery({ category: '不存在的领域' }).category, undefined);
    assert.equal(parseHomeQuery({ category: '不存在的领域' }).hasFilter, false);
  });

  it('hasFilter 只看筛选维度（翻页与 lead 都不算）', () => {
    assert.equal(parseHomeQuery({}).hasFilter, false);
    assert.equal(parseHomeQuery({ page: '2' }).hasFilter, false, '翻页不是筛选');
    assert.equal(parseHomeQuery({ lead: '1' }).hasFilter, false, '裸 lead 不改变结果');
    assert.equal(parseHomeQuery({ q: '意见' }).hasFilter, true);
    assert.equal(parseHomeQuery({ agency: '司法部' }).hasFilter, true);
    assert.equal(parseHomeQuery({ month: '2026-08' }).hasFilter, true, '月份是筛选维度（issue #45）');
    assert.equal(parseHomeQuery({ month: '2026-13' }).hasFilter, false, '非法月份不生效');
    assert.equal(parseHomeQuery({ period: 'b16_30' }).hasFilter, true, '公示期是筛选维度（issue #47）');
    assert.equal(parseHomeQuery({ period: 'nope' }).hasFilter, false, '非法桶 key 不生效');
    assert.equal(parseHomeQuery({ from: '2026-04' }).hasFilter, true, '区间下界是筛选维度');
    assert.equal(parseHomeQuery({ to: '2026-09' }).hasFilter, true, '区间上界是筛选维度');
    assert.equal(
      parseHomeQuery({ from: '2026-09', to: '2026-04' }).hasFilter,
      false,
      '倒置区间不生效（也就不是筛选）',
    );
  });

  it('?month= 是 from = to 的别名（issue #45 已发布的链接保持有效）', () => {
    const legacy = parseHomeQuery({ month: '2026-08' });
    assert.equal(legacy.from, '2026-08');
    assert.equal(legacy.to, '2026-08');
    assert.equal(legacy.hasFilter, true);
    // 显式区间优先于别名
    const explicit = parseHomeQuery({ month: '2026-08', from: '2026-01', to: '2026-06' });
    assert.equal(explicit.from, '2026-01');
    assert.equal(explicit.to, '2026-06');
  });

  it('半区间 + 别名：别名不补另一侧（不凭空造出区间）', () => {
    // 这是**不变量钉子**，不是修缺陷：旧实现的镜像守卫（`range.to === undefined ? 别名 : undefined`）
    // 在四种输入下与新实现完全等价，已逐例核对过。issue #50 只是把两个互为镜像的内联条件
    // 收成一个有名字的 `hasRange` —— 读者不必再自己推「哪一侧缺省时才认别名」。
    // 钉住的性质：别名只在**两端都没给区间**时生效，绝不会补上缺的那一侧。
    const halfLower = parseHomeQuery({ from: '2026-01', month: '2026-03' });
    assert.equal(halfLower.from, '2026-01');
    assert.equal(halfLower.to, undefined, '上界不该被别名填上');

    const halfUpper = parseHomeQuery({ to: '2026-03', month: '2026-01' });
    assert.equal(halfUpper.to, '2026-03');
    assert.equal(halfUpper.from, undefined, '下界不该被别名填上');
  });

  it('lead=1 只在显式传 1 时为真，其余值一律假', () => {
    assert.equal(parseHomeQuery({ lead: '1' }).leadAgencyOnly, true);
    for (const value of ['0', 'true', '', undefined]) {
      assert.equal(parseHomeQuery({ lead: value }).leadAgencyOnly, false, `lead=${value} 应为假`);
    }
  });

  it('筛选与页码可以并存（索引口径由 hasFilter 决定，与页码无关）', () => {
    assert.deepEqual(parseHomeQuery({ q: '意见', page: '3' }), {
      category: undefined,
      agency: undefined,
      keyword: '意见',
      from: undefined,
      to: undefined,
      period: undefined,
      leadAgencyOnly: false,
      page: 3,
      hasFilter: true,
    });
  });
});
