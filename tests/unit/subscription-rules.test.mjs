import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  AUDIENCE_OPTIONS,
  hasAnyRule,
  matchesSubscriptionRules,
  normalizeAgencies,
  normalizeAudiences,
  normalizeScope,
  validateSubscriptionRules,
} from '../../src/lib/subscription.ts';

/**
 * 单元：订阅规则的维度与匹配（issue #60 第 2 刀，issue #84 加受众面收窄）。
 *
 * 这一层的价值全在「同一份逻辑被三处复用」（订阅页校验、截止提醒、新公示通知）。
 * 分家的表现是「我明明订了却收不到」，而那种问题没有报错、没有日志，只能靠断言挡住。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readSource = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const rulesOf = (overrides = {}) => ({
  keywords: [],
  categories: [],
  agencies: [],
  audiences: [],
  scope: 'rules',
  ...overrides,
});

const noticeOf = (overrides = {}) => ({
  title: '关于某办法公开征求意见的公告',
  bodyText: '现就某办法向社会公开征求意见。',
  categoryTags: ['立法与司法'],
  agency: '测试部',
  // 未判定（含本列上线前的 NULL）：受众面测试显式传值，其余用例走"空 = 不限"
  audience: null,
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

/**
 * 受众面进订阅规则（issue #84）。这一组钉的是**它和其余三项不是同一种关系**：
 * 关键词 / 领域 / 机关是「任一命中即相关」（OR），受众面是「这类公示是不是给我的」（AND）。
 * 把 AND 写成 OR 的表现是订阅者**多收**一堆行业标准；把顺序写反（放在 scope='all'
 * 之后）的表现是"订全部 + 只看公众广域"的人收到全部 —— 两种都不报错。
 */
describe('issue #84：受众面是收窄条件（与关键词 / 领域 / 机关是 AND）', () => {
  it('可选项只有两档，未判定**刻意不能订**（没人会说"把没归好类的发给我"）', () => {
    assert.deepEqual(AUDIENCE_OPTIONS.map((option) => option.value), ['public', 'sector']);
    assert.deepEqual(AUDIENCE_OPTIONS.map((option) => option.label), ['公众广域', '行业专业']);
    for (const option of AUDIENCE_OPTIONS) {
      assert.ok(option.hint.length > 0, '每一档都要有一句给读者看的口径说明');
    }
  });

  it('normalizeAudiences：白名单过滤 + 去重 + 大小写与空白不敏感', () => {
    assert.deepEqual(normalizeAudiences(['public', 'sector']), ['public', 'sector']);
    assert.deepEqual(normalizeAudiences(' public , SECTOR '), ['public', 'sector'], '表单交来的是大小写各异的字面量');
    assert.deepEqual(normalizeAudiences(['unknown']), [], '未判定不是可订项，落库前就该被丢掉');
    assert.deepEqual(normalizeAudiences(['林草', '', '  ']), [], '未知取值一律丢掉，不当成新档');
    assert.deepEqual(normalizeAudiences(['public', 'public']), ['public'], '去重');
  });

  it('空数组 = 不限：本列上线前的订阅（以及"没有这个字段"的调用方）行为与旧版逐条一致', () => {
    assert.equal(matchesSubscriptionRules(rulesOf({ keywords: ['噪声'] }), noticeOf({ title: '噪声污染防治法（草案）' })), true);
    assert.equal(matchesSubscriptionRules(rulesOf(), noticeOf()), false, '仍然没有兜底成"全部"');
    // 条目侧未判定（NULL）不影响"不限"的人：他不勾，就不该因此少收
    assert.equal(matchesSubscriptionRules(rulesOf({ scope: 'all' }), noticeOf({ audience: 'unknown' })), true);
  });

  it('命中条件但受众面不符 ⇒ 不发（这正是 AND 与 OR 的差别）', () => {
    const sector = noticeOf({ title: '关于某技术规程公开征求意见的公告', audience: 'sector' });
    assert.equal(
      matchesSubscriptionRules(rulesOf({ keywords: ['技术规程'] }), sector),
      true,
      '不勾受众面时关键词命中就发（旧行为）',
    );
    assert.equal(
      matchesSubscriptionRules(rulesOf({ keywords: ['技术规程'], audiences: ['public'] }), sector),
      false,
      '勾了「公众广域」之后，行业专业的那条即使关键词命中也不该发 —— 这是收窄的全部意义',
    );
    assert.equal(
      matchesSubscriptionRules(rulesOf({ keywords: ['技术规程'], audiences: ['sector'] }), sector),
      true,
    );
  });

  it('只勾受众面是一条完整可用的订阅（"这类公示我都要"）', () => {
    assert.equal(hasAnyRule(rulesOf({ audiences: ['public'] })), true, '受众面单独出现也算有规则');
    assert.equal(
      matchesSubscriptionRules(rulesOf({ audiences: ['public'] }), noticeOf({ audience: 'public' })),
      true,
      '没有别的条件时，"命中受众面"本身就是命中',
    );
    assert.equal(
      matchesSubscriptionRules(rulesOf({ audiences: ['public'] }), noticeOf({ audience: 'sector' })),
      false,
    );
  });

  it('scope=all 也受受众面收窄（"全部新公示，但我只看公众广域"必须是那个意思）', () => {
    assert.equal(
      matchesSubscriptionRules(rulesOf({ scope: 'all' }), noticeOf({ audience: 'sector' })),
      true,
      '不勾受众面时订全部照旧一律命中',
    );
    assert.equal(
      matchesSubscriptionRules(rulesOf({ scope: 'all', audiences: ['public'] }), noticeOf({ audience: 'sector' })),
      false,
      '勾了就必须收窄：排在 scope=all 短路的后面就等于嘴上说收窄、实际发全部',
    );
    assert.equal(
      matchesSubscriptionRules(rulesOf({ scope: 'all', audiences: ['public'] }), noticeOf({ audience: 'public' })),
      true,
    );
  });

  it('未判定与 NULL 不算任何一档（否则「公众广域」这个名字就开始撒谎）', () => {
    for (const audience of ['unknown', null, undefined]) {
      assert.equal(
        matchesSubscriptionRules(rulesOf({ audiences: ['public', 'sector'] }), noticeOf({ audience })),
        false,
        `受众面 ${String(audience)} 不该被算进公众广域或行业专业`,
      );
    }
  });

  it('validateSubscriptionRules：受众面能单独撑起一条规则，未知值仍被拒', () => {
    assert.equal(validateSubscriptionRules([], [], [], 'rules', ['public']).ok, true);
    assert.deepEqual(validateSubscriptionRules([], [], [], 'rules', []), {
      ok: false,
      reason: 'no_rules',
    });
    assert.deepEqual(validateSubscriptionRules([], [], [], 'rules', ['林业']), {
      ok: false,
      reason: 'unknown_audience',
    });
  });
});
