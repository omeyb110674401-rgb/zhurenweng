import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DOMAIN_CATEGORIES,
  deriveCategoryTags,
  isKnownCategory,
} from '../../src/lib/categories.ts';

/**
 * 单元测试（issue #15）：领域打标规则表本身 —— 关键词命中、排除语境、无兜底标签。
 *
 * 为什么单独有这一层：规则表是纯函数，语义边界（尤其「排除语境」）在这里逐条钉死，
 * 不需要 next build 就能跑（Node 原生类型擦除直接 import TS 源码），比 e2e 快一个量级。
 * e2e（tests/e2e/category-filter.test.mjs）负责端到端：抓取入库 → 打标 → 列表筛选。
 *
 * 用例里的文本取自真实公示正文（issue #14 验证时抓到的原文），不是构造词。
 */

describe('issue #15：领域打标规则表', () => {
  it('关键词命中标题或正文即打标，多领域命中按词表顺序输出多标签', () => {
    // 标题命中 + 正文命中不同领域
    assert.deepEqual(
      deriveCategoryTags('道路交通安全法（修订草案）征求意见', '正文无领域词'),
      ['立法与司法', '交通运输'],
      '标题「草案」→ 立法与司法；「交通/道路」→ 交通运输（顺序即词表顺序）',
    );
    assert.deepEqual(deriveCategoryTags('标题无领域词', '海洋生态环境保护'), ['生态环境']);
    assert.deepEqual(deriveCategoryTags('标题无领域词', ''), [], '正文为空且标题无词');
    assert.deepEqual(deriveCategoryTags('标题无领域词', null), [], '正文为 null 同样不打标');
  });

  it('「草案」是立法活动标记：法案 / 条例草案打「立法与司法」', () => {
    assert.deepEqual(deriveCategoryTags('金融法（草案）公开征求意见的通知', ''), ['立法与司法']);
    assert.deepEqual(deriveCategoryTags('反跨境腐败法（草案）征求意见', ''), ['立法与司法']);
    assert.deepEqual(
      deriveCategoryTags('企业破产法（修订草案二次审议稿）征求意见', ''),
      ['立法与司法'],
    );
  });

  it('排除语境：「数据」只出现在专有名词「数据库」内不算命中', () => {
    assert.deepEqual(
      deriveCategoryTags('标题无领域词', '可登录国家法律法规数据库查阅'),
      [],
      '真实 npc 正文的唯一「数据」出现在「数据库」内',
    );
    assert.deepEqual(
      deriveCategoryTags('标题无领域词', '数据安全要求'),
      ['数据与网络安全'],
      '裸「数据」仍命中（排除语境不等于关掉关键词）',
    );
    assert.deepEqual(
      deriveCategoryTags('标题无领域词', '数据库与数据安全'),
      ['数据与网络安全'],
      '「数据库」与裸「数据」并存时仍命中（只剔除排除词本身）',
    );
  });

  it('排除语境：「信息化」只出现在机关名「工业和信息化部」内不算命中', () => {
    assert.deepEqual(
      deriveCategoryTags('标题无领域词', '征求意见单位：1.工业和信息化部办公厅 2.国家发展改革委办公厅'),
      [],
      '真实 mee 通知的征求意见单位名单含该机关名，不该把排放标准打进数据领域',
    );
    assert.deepEqual(
      deriveCategoryTags('标题无领域词', '推进环境监测信息化建设'),
      ['数据与网络安全'],
      '真领域文本仍命中',
    );
  });

  it('无兜底标签：没有任何关键词命中时返回空数组（设计行为，非缺陷）', () => {
    assert.deepEqual(deriveCategoryTags('关于公开征求《XX管理办法（征求意见稿）》意见的通知', '联系人：某某'), []);
  });

  it('领域词表自洽：标签唯一、关键词非空，且 isKnownCategory 只认词表内取值', () => {
    const labels = DOMAIN_CATEGORIES.map((domain) => domain.label);
    assert.equal(new Set(labels).size, labels.length, '标签不应重复');
    for (const domain of DOMAIN_CATEGORIES) {
      assert.ok(domain.keywords.length > 0, `${domain.label} 应有关键词`);
      assert.ok(isKnownCategory(domain.label), `${domain.label} 应被 isKnownCategory 认可`);
      for (const keyword of domain.keywords) {
        assert.ok(keyword.trim() === keyword && keyword.length > 0, `${domain.label} 的关键词应为非空去空白串`);
      }
    }
    assert.ok(!isKnownCategory('其他'), '未登记的取值不生效（避免任意串触发无效筛选）');
  });
});
