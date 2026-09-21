import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PERIOD_BUCKETS,
  bucketOfDays,
  isPeriodBucketKey,
  periodBucketLabel,
} from '../../src/lib/notice-period.ts';

/**
 * 单元：公示期分桶的定义（issue #46 / #47）。
 *
 * 这组断言针对的是一类**结构性隐患**：桶的边界与页面文案如果各写一份，就会漂移 ——
 * issue #46 的线上缺陷正是如此（边界是 `> 30`，标签写「30 天以上」，30 落在两个桶里，
 * 读者无法判断它算哪一桶）。现在两者是同一条记录，本文件再把「标签里的数字必须与
 * 边界一致」「分桶不重叠不留缝」钉死。
 */

describe('PERIOD_BUCKETS：分桶定义', () => {
  it('标签里的数字与边界一致（防止再次出现「标签说 30 天以上、边界是 31+」）', () => {
    for (const bucket of PERIOD_BUCKETS) {
      const bound = bucket.minDays ?? bucket.maxDays;
      assert.ok(bound !== null, `桶 ${bucket.key} 必须至少有一个边界`);
      assert.ok(
        bucket.label.includes(String(bound)),
        `桶 ${bucket.key} 的标签「${bucket.label}」必须写出边界数字 ${bound}`,
      );
    }
  });

  it('分桶覆盖全部整数且互不重叠（-10 ~ 200 天逐日验证）', () => {
    const seen = new Set();
    for (let days = -10; days <= 200; days += 1) {
      const key = bucketOfDays(days);
      assert.ok(
        isPeriodBucketKey(key),
        `${days} 天应落在已定义的桶内，实际 ${key}`,
      );
      seen.add(key);
    }
    assert.equal(seen.size, PERIOD_BUCKETS.length, '每个桶都应被覆盖到');
  });

  it('边界值归属明确：7/8 之间与 15/16、30/31 之间不重叠', () => {
    assert.equal(bucketOfDays(7), 'lte7');
    assert.equal(bucketOfDays(8), 'b8_15');
    assert.equal(bucketOfDays(15), 'b8_15');
    assert.equal(bucketOfDays(16), 'b16_30');
    assert.equal(bucketOfDays(30), 'b16_30', '30 天属于 16-30 桶（标签不得再写「30 天以上」）');
    assert.equal(bucketOfDays(31), 'gt30');
    assert.equal(bucketOfDays(365), 'gt30');
  });

  it('0 天与负天数（截止早于发布的数据异常）都归最短桶，不抛错', () => {
    assert.equal(bucketOfDays(0), 'lte7');
    assert.equal(bucketOfDays(-3), 'lte7');
  });
});

describe('桶 key 的校验与文案', () => {
  it('isPeriodBucketKey 只认定义过的 key', () => {
    for (const bucket of PERIOD_BUCKETS) {
      assert.equal(isPeriodBucketKey(bucket.key), true);
    }
    for (const bad of ['', 'lte8', 'gt31', '7', 'LTE7', 'lte7 ', 'unknown']) {
      assert.equal(isPeriodBucketKey(bad), false, `「${bad}」不该被认作桶 key`);
    }
  });

  it('periodBucketLabel 取展示文案；未知 key 返回 null（不兜底成别的桶名）', () => {
    assert.equal(periodBucketLabel('gt30'), '31 天及以上');
    assert.equal(periodBucketLabel('lte7'), '7 天以内（含 7 天）');
    assert.equal(periodBucketLabel('nope'), null);
  });
});
