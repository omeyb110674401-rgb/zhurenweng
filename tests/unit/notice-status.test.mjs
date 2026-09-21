import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { effectiveStatus, noticeStatusLabel } from '../../src/lib/notice-status.ts';

/**
 * 单元：展示用有效状态（issue #43）。
 *
 * 状态列是抓取时推导的，而抓取每日一轮 —— 北京时间 00:00 到下一轮抓取之间
 * （生产实测约 14 小时），刚过截止的条目在库里仍是 open，页面于是写着
 * 「征求意见中」而倒计时已静默消失。这里钉死复核规则与它的边界：
 * 只复核 open 那一档（closed / resulted 以库内为准），且按北京日历日切。
 */

const NOW = new Date('2026-09-21T06:00:00Z'); // 北京 2026-09-21 14:00

function notice(status, deadlineAt) {
  return { status, deadlineAt };
}

describe('effectiveStatus：展示用有效状态', () => {
  it('库内 open + 截止日已过 → closed（这就是那 14 小时窗口）', () => {
    assert.equal(effectiveStatus(notice('open', '2026-09-20'), NOW), 'closed');
    assert.equal(effectiveStatus(notice('open', '2026-08-01'), NOW), 'closed');
  });

  it('库内 open + 截止日就是今天 → 仍是 open（截止当天可以提意见）', () => {
    assert.equal(effectiveStatus(notice('open', '2026-09-21'), NOW), 'open');
  });

  it('库内 open + 截止日在未来 → open', () => {
    assert.equal(effectiveStatus(notice('open', '2026-09-22'), NOW), 'open');
    assert.equal(effectiveStatus(notice('open', '2026-10-21'), NOW), 'open');
  });

  it('库内 open 但取不到截止日期 → open（推不出结论，不擅自改口）', () => {
    assert.equal(effectiveStatus(notice('open', null), NOW), 'open');
    assert.equal(effectiveStatus(notice('open', '待定'), NOW), 'open');
  });

  it('closed / resulted 一律以库内为准（源站比日期权威，结果状态也推不出来）', () => {
    assert.equal(
      effectiveStatus(notice('closed', '2026-12-31'), NOW),
      'closed',
      '源站提前结束征集：截止日期还没到也该是已截止',
    );
    assert.equal(effectiveStatus(notice('resulted', '2026-09-01'), NOW), 'resulted');
    assert.equal(effectiveStatus(notice('resulted', '2026-12-31'), NOW), 'resulted');
  });

  it('边界按北京日历日切（与 daysUntil 同口径）', () => {
    // 北京 09-21 00:30 = UTC 09-20 16:30 → 截止 09-20 的条目此刻已过期
    assert.equal(
      effectiveStatus(notice('open', '2026-09-20'), new Date('2026-09-20T16:30:00Z')),
      'closed',
    );
    // 北京 09-20 23:59 仍算 09-20 当天
    assert.equal(
      effectiveStatus(notice('open', '2026-09-20'), new Date('2026-09-20T15:59:00Z')),
      'open',
    );
  });
});

describe('状态文案容错（issue #51）', () => {
  it('已知状态给中文文案', () => {
    assert.equal(noticeStatusLabel('open'), '征求意见中');
    assert.equal(noticeStatusLabel('closed'), '已截止');
    assert.equal(noticeStatusLabel('resulted'), '已出结果');
  });

  it('未知取值原样返回 —— 不渲染 undefined，也不猜成别的状态', () => {
    // status 是 TEXT 列，仓储层直接 `as NoticeStatus`（类型断言不校验运行时值）。
    // 库里一旦出现集合外的值，`Record<NoticeStatus, string>` 的索引会给出 undefined：
    // 页面上是一个空徽标、JSON-LD 里是 "creativeWorkStatus": undefined ——
    // 读者与消费方都拿不到任何信息。原样显示至少把真相摆出来。
    assert.equal(noticeStatusLabel('archived'), 'archived');
    assert.equal(noticeStatusLabel(''), '');
    assert.equal(noticeStatusLabel('OPEN'), 'OPEN', '大小写不同即未知值，不擅自归一');
  });
});
