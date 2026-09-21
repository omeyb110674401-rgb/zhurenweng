import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  diffComparability,
  diffNoticeBodies,
  splitClauses,
} from '../../src/lib/notice-diff.ts';

/**
 * 单元：版本对比的可比性判定（issue #42）。
 *
 * 背景：`diffNoticeBodies(上一版正文, null)` 会把上一版每个条款都输出成 removed ——
 * 对比页于是整篇显示「删除」，读者以为这一轮把草案全删了；而真相是我们这轮没抓到
 * 正文（同一时刻详情页显示的是「正文未取到」）。反向则整篇「新增」。原有空态只在
 * **两侧都空**时才出现，所以这种谎报此前完全静默。
 *
 * 这里钉两件事：① 可比性四态（含纯空白正文算「没有正文」）；② 函数守卫 ——
 * 不可比时**一个差异行都不产生**，宁可空着也不编内容。
 */

const OLD_BODY = ['第一章 总 则', '第一条 为了加强湿地保护，制定本法。', '第二条 本法适用于中华人民共和国领域。'].join('\n');
const NEW_BODY = [
  '第一章 总 则',
  '第一条 为了加强湿地保护，推进生态文明建设，制定本法。',
  '第二条 本法适用于中华人民共和国领域。',
  '第三条 国家建立湿地面积总量管控制度。',
].join('\n');

describe('diffComparability：两轮正文的可比性', () => {
  it('两侧都有条款 → comparable', () => {
    assert.equal(diffComparability(OLD_BODY, NEW_BODY), 'comparable');
  });

  it('本轮缺正文 / 上一轮缺正文 / 两侧都缺（含空串、纯空白、null、undefined）', () => {
    for (const empty of [null, undefined, '', '   ', '\n\n\t ']) {
      assert.equal(diffComparability(OLD_BODY, empty), 'missing-new', `本轮 ${JSON.stringify(empty)}`);
      assert.equal(diffComparability(empty, NEW_BODY), 'missing-old', `上一轮 ${JSON.stringify(empty)}`);
      assert.equal(diffComparability(empty, empty), 'missing-both');
    }
  });

  it('判定口径与切分函数一致：切不出条款就算没有正文', () => {
    for (const body of [null, undefined, '', ' \n ', '正文']) {
      assert.equal(
        splitClauses(body).length > 0,
        diffComparability(body, OLD_BODY) === 'comparable',
        `「${String(body)}」的判定应与 splitClauses 一致`,
      );
    }
  });
});

describe('diffNoticeBodies：不可比时一个差异行都不产生', () => {
  it('本轮缺正文：不再把上一版整篇报成「删除」', () => {
    // 修复前的行为：返回 3 行 removed（「删除 第一章/第一条/第二条」）
    assert.deepEqual(diffNoticeBodies(OLD_BODY, null), []);
    assert.deepEqual(diffNoticeBodies(OLD_BODY, ''), []);
    assert.deepEqual(diffNoticeBodies(OLD_BODY, '   '), []);
  });

  it('上一轮缺正文：不再把本轮整篇报成「新增」', () => {
    assert.deepEqual(diffNoticeBodies(null, NEW_BODY), []);
    assert.deepEqual(diffNoticeBodies('', NEW_BODY), []);
  });

  it('两侧都缺：空数组（由页面给「两轮都无正文」说明）', () => {
    assert.deepEqual(diffNoticeBodies(null, null), []);
  });

  it('可比时照常产出差异行（守卫不能误伤正常对比）', () => {
    const rows = diffNoticeBodies(OLD_BODY, NEW_BODY);
    assert.ok(rows.length > 0, '可比时应产出差异行');
    const kinds = new Set(rows.map((row) => row.kind));
    assert.ok(kinds.has('same'), '相同条款应保留');
    assert.ok(
      kinds.has('added') || kinds.has('modified'),
      '新版新增/改写的条款应体现为 added 或 modified',
    );
  });
});
