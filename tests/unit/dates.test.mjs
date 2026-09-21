import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { daysUntil, normalizeDateText, siteDateIso, siteMonthIso } from '../../src/lib/dates.ts';

/**
 * 单元：日期归一与倒计时（issue #24 补丁 + issue #40 时区）。
 *
 * 背景 1（#24）：`extract.ts` 的截止日期正则一直「认」斜杠写法，但
 * `normalizeDateText` 只认 ISO 与中文写法 —— 正则匹配成功却在归一化那一步返回
 * null，等于没认。线上数据里尚未出现斜杠写法的截止日期，属**潜在**缺陷；但同一
 * 函数也用在列表发布日期上（如教育部 `title` 属性、市场监管总局征集期），一旦
 * 某个源改用斜杠/点分写法，发布日期与截止日期都会静默丢失，连带影响倒计时、
 * 列表排序与截止提醒（7 天 / 3 天两封）。这里把四种写法钉死。
 *
 * 背景 2（#40）：这些日历口径全部按**站点日历日（东八区）**算，不按进程时区 ——
 * 生产容器跑在 UTC、开发机在东八区，按进程时区取「今天」会在北京时间
 * 00:00–08:00 这 8 小时里错一天（倒计时多显示一天、刚过期的条目仍算「征求意见中」、
 * 出站点击记到前一天）。因此本文件里的时刻**一律用绝对时刻**（带 Z 的字符串）
 * 构造：`new Date(2026, 8, 20, 23, 30)` 是「进程时区的那一瞬间」，同一行断言在
 * UTC 与东八区指的不是同一时刻 —— 那正是本次缺陷的形态。末尾另用子进程换 TZ
 * 直接验证「与进程时区无关」。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

describe('daysUntil：按站点日历日（东八区）计算', () => {
  const now = new Date('2026-09-20T15:30:00Z'); // 北京时间 2026-09-20 23:30

  it('今天截止为 0、明天为 1、已过为负', () => {
    assert.equal(daysUntil('2026-09-20', now), 0);
    assert.equal(daysUntil('2026-09-21', now), 1);
    assert.equal(daysUntil('2026-09-19', now), -1);
    assert.equal(daysUntil('2026-09-27', now), 7, '7 天提醒的判定基准');
    assert.equal(daysUntil('2026-09-23', now), 3, '3 天提醒的判定基准');
  });

  it('北京时间当天深夜与凌晨都不把「今天截止」算成已过期', () => {
    // 北京 23:59:59 = UTC 15:59:59；北京 00:00:01 = UTC 前一天 16:00:01
    assert.equal(daysUntil('2026-09-20', new Date('2026-09-20T15:59:59Z')), 0);
    assert.equal(daysUntil('2026-09-20', new Date('2026-09-19T16:00:01Z')), 0);
  });

  it('跨日边界按北京时间切：UTC 还在 20 日时，北京已是 21 日（issue #40 的错例）', () => {
    const beijingEarlyMorning = new Date('2026-09-20T16:30:00Z'); // 北京 09-21 00:30
    assert.equal(daysUntil('2026-09-21', beijingEarlyMorning), 0, '今天截止，不该显示「剩 1 天」');
    assert.equal(daysUntil('2026-09-20', beijingEarlyMorning), -1, '北京已跨日，昨天截止的条目应已过期');
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

describe('siteDateIso / siteMonthIso：站点日历日（东八区）', () => {
  it('补零到 YYYY-MM-DD', () => {
    assert.equal(siteDateIso(new Date('2026-01-05T00:00:00Z')), '2026-01-05', '北京 08:00');
    assert.equal(siteDateIso(new Date('2026-12-31T15:59:00Z')), '2026-12-31', '北京 23:59');
  });

  it('跨日边界：UTC 日期与北京日期相差一天的那 8 小时', () => {
    assert.equal(siteDateIso(new Date('2026-09-21T15:59:59Z')), '2026-09-21', '北京 23:59:59');
    assert.equal(siteDateIso(new Date('2026-09-21T16:00:00Z')), '2026-09-22', '北京 00:00:00');
    assert.equal(siteDateIso(new Date('2026-09-21T23:59:59Z')), '2026-09-22', 'UTC 还是 21 日，北京已是 22 日');
  });

  it('月份口径同样按东八区（统计页趋势窗口的当前月）', () => {
    assert.equal(siteMonthIso(new Date('2026-09-30T15:59:59Z')), '2026-09', '北京 09-30 23:59');
    assert.equal(siteMonthIso(new Date('2026-09-30T16:00:00Z')), '2026-10', '北京 10-01 00:00：跨月');
  });

  it('与进程时区无关：换 TZ 跑同一断言（生产容器是 UTC、开发机是东八区）', () => {
    // 只断言「本机跑出来对」是不够的 —— 本机恰好是东八区，旧实现也能过。
    // 用子进程分别以 UTC / 东八区 / 纽约 / 基里巴斯跑同一个函数，要求答案一致。
    const script = [
      "import { siteDateIso } from './src/lib/dates.ts';",
      "process.stdout.write(",
      "  siteDateIso(new Date('2026-09-21T16:30:00Z')) + '|' +",
      "  siteDateIso(new Date('2026-09-21T15:30:00Z')) + '|' +",
      "  siteDateIso(new Date('2026-09-21T23:59:59Z')));",
    ].join(' ');
    for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York', 'Pacific/Kiritimati']) {
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: repoRoot,
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
      });
      assert.equal(
        out,
        '2026-09-22|2026-09-21|2026-09-22',
        `TZ=${tz} 下应给出同样的站点日历日（北京 09-22 00:30 / 09-21 23:30 / 09-22 07:59）`,
      );
    }
  });
});
