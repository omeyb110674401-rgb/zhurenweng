import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { daysUntil, localDateIso, normalizeDateText } from '../../src/lib/dates.ts';

/**
 * 单元：日期归一与倒计时（issue #24 补丁）。
 *
 * 背景：`extract.ts` 的截止日期正则一直「认」斜杠写法，但 `normalizeDateText`
 * 只认 ISO 与中文写法 —— 正则匹配成功却在归一化那一步返回 null，等于没认。
 * 线上数据里尚未出现斜杠写法的截止日期，属**潜在**缺陷；但同一函数也用在
 * 列表发布日期上（如教育部 `title` 属性、市场监管总局征集期），一旦某个源改用
 * 斜杠/点分写法，发布日期与截止日期都会静默丢失，连带影响倒计时、列表排序
 * 与截止提醒（7 天 / 3 天两封）。这里把四种写法钉死。
 */

describe('normalizeDateText：四种日期写法', () => {
  it('ISO / 斜杠 / 点分 / 中文都归一为 YYYY-MM-DD', () => {
    assert.equal(normalizeDateText('2026-09-07'), '2026-09-07');
    assert.equal(normalizeDateText('2026/09/07'), '2026-09-07', '斜杠写法曾是漏网的');
    assert.equal(normalizeDateText('2026.09.07'), '2026-09-07', '点分写法（部分政务站用）');
    assert.equal(normalizeDateText('2026年9月7日'), '2026-09-07');
  });

  it('混杂上下文里也能取出日期（列表日期带时刻、带前后缀）', () => {
    assert.equal(normalizeDateText('2026-09-07 17:00'), '2026-09-07');
    assert.equal(normalizeDateText('发布日期：2026/9/7'), '2026-09-07');
    assert.equal(normalizeDateText('2026年9月7日 来源：法制司'), '2026-09-07');
    assert.equal(normalizeDateText('公示期 2026.9.7 至 2026.10.7'), '2026-09-07');
  });

  it('非法日期返回 null（不猜、不溢出到下一个月）', () => {
    assert.equal(normalizeDateText('2026-02-30'), null, '2 月没有 30 日');
    assert.equal(normalizeDateText('2026-13-01'), null);
    assert.equal(normalizeDateText('2026-00-10'), null);
    assert.equal(normalizeDateText(''), null);
    assert.equal(normalizeDateText(undefined), null);
    assert.equal(normalizeDateText('没有日期'), null);
  });

  it('闰年边界正确（2028 是闰年，2026 不是）', () => {
    assert.equal(normalizeDateText('2028-02-29'), '2028-02-29');
    assert.equal(normalizeDateText('2026-02-29'), null);
  });
});

describe('daysUntil：按本地日历日计算', () => {
  const now = new Date(2026, 8, 20, 23, 30); // 2026-09-20 23:30 本地

  it('今天截止为 0、明天为 1、已过为负', () => {
    assert.equal(daysUntil('2026-09-20', now), 0);
    assert.equal(daysUntil('2026-09-21', now), 1);
    assert.equal(daysUntil('2026-09-19', now), -1);
    assert.equal(daysUntil('2026-09-27', now), 7, '7 天提醒的判定基准');
    assert.equal(daysUntil('2026-09-23', now), 3, '3 天提醒的判定基准');
  });

  it('当天深夜不会把「今天截止」算成已过期（跨时区无关）', () => {
    const lateNight = new Date(2026, 8, 20, 23, 59, 59);
    assert.equal(daysUntil('2026-09-20', lateNight), 0);
    const earlyMorning = new Date(2026, 8, 20, 0, 0, 1);
    assert.equal(daysUntil('2026-09-20', earlyMorning), 0);
  });

  it('斜杠写法的截止日期同样可算（与 normalizeDateText 同口径）', () => {
    assert.equal(daysUntil('2026/09/27', now), 7);
  });

  it('无法解析或为空时返回 null', () => {
    assert.equal(daysUntil(null, now), null);
    assert.equal(daysUntil('', now), null);
    assert.equal(daysUntil('待定', now), null);
  });
});

describe('localDateIso：本地日历日', () => {
  it('补零到 YYYY-MM-DD', () => {
    assert.equal(localDateIso(new Date(2026, 0, 5, 8, 0)), '2026-01-05');
    assert.equal(localDateIso(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
  });
});
