import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  hasAnyRule,
  matchesSubscriptionRules,
  normalizeAgencies,
  normalizeScope,
  validateSubscriptionRules,
} from '../../src/lib/subscription.ts';

/**
 * 单元：订阅规则的维度与匹配（issue #60 第 2 刀）。
 *
 * 这一层的价值全在「同一份逻辑被三处复用」（订阅页校验、截止提醒、将来的新公示通知）。
 * 分家的表现是「我明明订了却收不到」，而那种问题没有报错、没有日志，只能靠断言挡住。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readSource = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const rulesOf = (overrides = {}) => ({
  keywords: [],
  categories: [],
  agencies: [],
  scope: 'rules',
  ...overrides,
});

const noticeOf = (overrides = {}) => ({
  title: '关于某办法公开征求意见的公告',
  bodyText: '现就某办法向社会公开征求意见。',
  categoryTags: ['立法与司法'],
  agency: '测试部',
  ...overrides,
});

describe('normalizeAgencies：与入库拆分同源', () => {
  it('分隔符切分 + 别名收敛 + 去重去空', () => {
    assert.deepEqual(normalizeAgencies('司法部、中国人民银行'), ['司法部', '中国人民银行']);
    assert.deepEqual(
      normalizeAgencies(['中国民航局', '中国民航局', '  ', '司法部 ']),
      ['中国民用航空局', '司法部'],
      '别名要收敛成同一个名字，且去重保序',
    );
  });

  it('数量与长度有上限（这是会被写进 JSON 落库的客户端输入）', () => {
    const many = normalizeAgencies(Array.from({ length: 60 }, (_v, i) => `机关${i}`));
    assert.equal(many.length, 30);
    assert.deepEqual(normalizeAgencies(['很长的机关名'.repeat(30)]), [], '超长条目应整条丢弃');
  });
});

describe('normalizeScope：只认显式的 all', () => {
  it('缺省 / 空 / 拼错都落回 rules（大小写与首尾空白不敏感，表单只会交来 rules/all）', () => {
    for (const raw of [undefined, null, '', 'rules', 'everything', 'true', 'alll']) {
      assert.equal(normalizeScope(raw), 'rules', `${JSON.stringify(raw)} 不该被当成订全部`);
    }
    assert.equal(normalizeScope('ALL'), 'all');
    assert.equal(normalizeScope(' all '), 'all');
  });
});

describe('matchesSubscriptionRules：机关按参与机关逐个精确相等', () => {
  it('联合发文的每个参与机关都能单独命中', () => {
    const joint = noticeOf({ agency: '交通运输部、中国民用航空局' });
    assert.equal(matchesSubscriptionRules(rulesOf({ agencies: ['中国民用航空局'] }), joint), true);
    assert.equal(matchesSubscriptionRules(rulesOf({ agencies: ['司法部'] }), joint), false);
  });

  it('不做子串匹配：订「司法部」不该命中「司法部办公厅」', () => {
    assert.equal(
      matchesSubscriptionRules(rulesOf({ agencies: ['司法部'] }), noticeOf({ agency: '司法部办公厅' })),
      false,
    );
  });

  it('条目侧的别名与空白写法也归一（源站排面差异不该让用户收不到）', () => {
    assert.equal(
      matchesSubscriptionRules(rulesOf({ agencies: ['中国民用航空局'] }), noticeOf({ agency: '中国民航局' })),
      true,
    );
  });

  it('scope=all 一律命中，且不再看任何条件', () => {
    assert.equal(matchesSubscriptionRules(rulesOf({ scope: 'all' }), noticeOf()), true);
    assert.equal(
      matchesSubscriptionRules(rulesOf({ scope: 'all', keywords: ['完全不相关的词'] }), noticeOf()),
      true,
    );
  });

  it('规则全空且没订全部 ⇒ 什么都不命中（防御：表单已强制非空）', () => {
    assert.equal(matchesSubscriptionRules(rulesOf(), noticeOf()), false);
    assert.equal(hasAnyRule(rulesOf()), false);
    assert.equal(hasAnyRule(rulesOf({ agencies: ['司法部'] })), true);
  });

  it('关键词与领域沿用原口径不受影响', () => {
    assert.equal(matchesSubscriptionRules(rulesOf({ keywords: ['噪声'] }), noticeOf({ title: '噪声污染防治法（草案）征求意见' })), true);
    assert.equal(matchesSubscriptionRules(rulesOf({ categories: ['生态环境'] }), noticeOf({ categoryTags: ['生态环境'] })), true);
  });
});

describe('validateSubscriptionRules：范围与条件的关系是显式的', () => {
  it('按条件时空规则被拒（并把机关算作一条有效条件）', () => {
    assert.deepEqual(validateSubscriptionRules([], []), { ok: false, reason: 'no_rules' });
    assert.equal(validateSubscriptionRules([], [], ['司法部'], 'rules').ok, true);
  });

  it('scope=all 时不要求任何条件（这是用户明确选的范围，不是漏填）', () => {
    assert.equal(validateSubscriptionRules([], [], [], 'all').ok, true);
  });

  it('未知领域仍被拒；未知机关不拒（新机关还没入库正是他想要的那条）', () => {
    assert.deepEqual(validateSubscriptionRules([], ['不存在的领域'], []), {
      ok: false,
      reason: 'unknown_category',
    });
    assert.equal(validateSubscriptionRules([], [], ['某个还没出现过的部委'], 'rules').ok, true);
  });
});

describe('复用同源：提醒任务与订阅页用的是同一份判定', () => {
  it('提醒任务不自己写一份匹配逻辑', () => {
    const job = readSource('worker/jobs/send-deadline-reminders.ts');
    assert.match(job, /matchesSubscriptionRules/, '提醒任务必须走同一个判定函数');
    assert.ok(
      !/subscription\.keywords\.some|\.includes\(keyword\)/.test(job),
      '任务里出现自己的关键词匹配代码 = 第二份口径，"订了收不到"从此不可解释',
    );
  });
});
