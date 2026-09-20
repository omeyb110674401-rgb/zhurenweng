import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  agencyKeysOf,
  canonicalAgency,
  leadAgencyOf,
  splitAgencies,
} from '../../src/lib/agencies.ts';

/**
 * 单元（issue #21）：发布机关名归一与多发布机关拆分。
 *
 * 规则类的改动必须钉死输入输出：这里覆盖别名收敛、复合串拆分（顿号 / 空白 / 混用）、
 * 去重保序、牵头机关、竖线包夹串（含**子串误命中**的反向断言 —— 竖线包夹的意义就是
 * 「司法部」不命中「司法部办公厅」）。全部用例取自生产库的真实机关取值
 * （2026-09-20 实测 150 条 / 18 种写法）。
 */

describe('发布机关名归一（issue #21）', () => {
  it('别名收敛：同一机关的简称与全称归一为规范名', () => {
    assert.equal(canonicalAgency('中国民航局'), '中国民用航空局');
    assert.equal(canonicalAgency('中国民用航空局'), '中国民用航空局', '规范名本身不变');
  });

  it('无别名的机关原样返回（不做猜测性归一）', () => {
    for (const name of [
      '司法部',
      '生态环境部办公厅',
      '市场监管总局特种设备局',
      '全国人大常委会法制工作委员会',
      '国家互联网信息办公室',
    ]) {
      assert.equal(canonicalAgency(name), name);
    }
  });

  it('首尾与内部空白折叠', () => {
    assert.equal(canonicalAgency('  司法部  '), '司法部');
    assert.equal(canonicalAgency('公安部   国家互联网信息办公室'), '公安部 国家互联网信息办公室');
  });

  it('拆分复合串：顿号分隔（司法部牵头的五部门联合发文）', () => {
    assert.deepEqual(splitAgencies('司法部、中国人民银行、金融监管总局、中国证监会、国家外汇局'), [
      '司法部',
      '中国人民银行',
      '金融监管总局',
      '中国证监会',
      '国家外汇局',
    ]);
  });

  it('拆分复合串：空白分隔（两种真实排版）', () => {
    assert.deepEqual(splitAgencies('公安部 国家互联网信息办公室'), ['公安部', '国家互联网信息办公室']);
    assert.deepEqual(splitAgencies('司法部 国家发展改革委'), ['司法部', '国家发展改革委']);
    assert.deepEqual(splitAgencies('人力资源社会保障部办公厅 教育部办公厅'), [
      '人力资源社会保障部办公厅',
      '教育部办公厅',
    ]);
  });

  it('拆分时逐个归一、去重并保序', () => {
    // 联合发文里同时出现简称与全称时收敛成一个（顺序取首次出现）
    assert.deepEqual(splitAgencies('中国民航局、中国民用航空局'), ['中国民用航空局']);
    assert.deepEqual(splitAgencies('教育部 教育部'), ['教育部']);
  });

  it('单机关与空串的边界', () => {
    assert.deepEqual(splitAgencies('司法部'), ['司法部']);
    assert.deepEqual(splitAgencies(''), []);
    assert.deepEqual(splitAgencies('   '), []);
    assert.equal(leadAgencyOf(''), '');
  });

  it('牵头机关 = 第一个参与机关（联合发文在统计里归到它名下，不重复计数）', () => {
    assert.equal(leadAgencyOf('司法部、中国人民银行、金融监管总局'), '司法部');
    assert.equal(leadAgencyOf('公安部 国家互联网信息办公室'), '公安部');
    assert.equal(leadAgencyOf('中国民航局、教育部'), '中国民用航空局', '牵头机关同样归一');
    assert.equal(leadAgencyOf('司法部'), '司法部');
  });

  it('参与机关键为竖线包夹串，且不产生子串误命中', () => {
    assert.equal(agencyKeysOf('司法部、中国人民银行'), '|司法部|中国人民银行|');
    assert.equal(agencyKeysOf('司法部'), '|司法部|');
    assert.equal(agencyKeysOf(''), '');

    // 反向断言：竖线包夹的意义 —— 查「司法部」不该命中「司法部办公厅」
    const keys = agencyKeysOf('司法部办公厅、教育部办公厅');
    assert.ok(keys.includes('|司法部办公厅|'));
    assert.ok(!keys.includes('|司法部|'), '「司法部」不应命中「司法部办公厅」');
  });
});
