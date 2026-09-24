import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isNewNotice,
  MAX_SINCE_DAYS,
  NEW_BADGE_DAYS,
  recencyCutoffIso,
  SINCE_OPTION_DAYS,
} from '../../src/lib/notice-recency.ts';

/**
 * 单元（issue #62）：「最近新增」的时间窗口。
 *
 * 值得单测的不是"算得对不对"这种一眼事，而是两件事：
 * 1. **下界的字符串形状**。仓储层拿它去比 `first_seen_at >= ?`，而两边都是**文本列**：
 *    同形状的 UTC ISO 串按字节序比较才等价于按时间比较。哪天这里改成带偏移量的写法
 *    （`+08:00`）或丢掉毫秒，SQL 不会报错，只会安静地把条目分错边 —— 编译期和运行期都不响。
 * 2. **NULL 与脏值一律判"不是新"**。存量行 `first_seen_at` 为空（迁移 0013 之前入库），
 *    把它们说成「新」等于对读者撒谎。
 */

const NOW = new Date('2026-09-24T09:00:00.000Z');

describe('issue #62：recencyCutoffIso 的形状与算法', () => {
  it('下界是 Date#toISOString() 的形状（与 first_seen_at 的写入值同形，字符串比较才成立）', () => {
    const cutoff = recencyCutoffIso(NOW, 7);
    assert.match(cutoff, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(cutoff, '2026-09-17T09:00:00.000Z');
    assert.equal(
      cutoff.length,
      new Date().toISOString().length,
      '长度必须与入库值一致：字节序比较要求两侧同形状',
    );
  });

  it('窗口是滚动的 N×24 小时，不做日历日取整（否则边界会在半夜跳变）', () => {
    assert.equal(recencyCutoffIso(NOW, 1), '2026-09-23T09:00:00.000Z');
    assert.equal(recencyCutoffIso(NOW, 0), NOW.toISOString());
  });
});

describe('issue #62：isNewNotice（列表「新」角标的判据）', () => {
  it('窗口内为真、窗口外为假；正好落在下界算窗口内', () => {
    assert.equal(isNewNotice(recencyCutoffIso(NOW, NEW_BADGE_DAYS), NOW), true);
    assert.equal(isNewNotice('2026-09-17T08:59:59.999Z', NOW), false);
    assert.equal(isNewNotice('2026-09-24T08:59:59.000Z', NOW), true);
  });

  it('缺收录时间的存量行不算新（宁可不标，也不把"不知道什么时候进来的"说成"新"）', () => {
    assert.equal(isNewNotice(null, NOW), false);
    assert.equal(isNewNotice(undefined, NOW), false);
    assert.equal(isNewNotice('', NOW), false);
    assert.equal(isNewNotice('不是时间戳', NOW), false, '脏值不该抛出，也不该判成真');
  });

  it('角标窗口独立于 ?since= 的选项（跟筛选走的话，选 90 天时人人带角标，标记就不传递信息了）', () => {
    assert.ok(!SINCE_OPTION_DAYS.includes(0));
    assert.ok(SINCE_OPTION_DAYS.every((days) => days >= NEW_BADGE_DAYS));
    assert.equal(MAX_SINCE_DAYS, Math.max(...SINCE_OPTION_DAYS), 'sinceParam 的上界就是最大选项');
  });
});
