import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { firstParam, pageParam, parseHomeQuery } from '../../src/app/_lib/home-query.ts';

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

describe('parseHomeQuery：筛选状态与索引口径', () => {
  it('未知领域值不生效（避免任意 querystring 触发无效筛选）', () => {
    assert.equal(parseHomeQuery({ category: '生态环境' }).category, '生态环境');
    assert.equal(parseHomeQuery({ category: '不存在的领域' }).category, undefined);
    assert.equal(parseHomeQuery({ category: '不存在的领域' }).hasFilter, false);
  });

  it('hasFilter 只看三个筛选维度（翻页与 lead 都不算）', () => {
    assert.equal(parseHomeQuery({}).hasFilter, false);
    assert.equal(parseHomeQuery({ page: '2' }).hasFilter, false, '翻页不是筛选');
    assert.equal(parseHomeQuery({ lead: '1' }).hasFilter, false, '裸 lead 不改变结果');
    assert.equal(parseHomeQuery({ q: '意见' }).hasFilter, true);
    assert.equal(parseHomeQuery({ agency: '司法部' }).hasFilter, true);
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
      leadAgencyOnly: false,
      page: 3,
      hasFilter: true,
    });
  });
});
