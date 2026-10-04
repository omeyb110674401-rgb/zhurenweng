import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redraftCandidate } from '../../src/lib/redraft-candidates.ts';
import { MANUAL_SUMMARY_MODEL } from '../../src/lib/summary-content.ts';

/**
 * 单元：存量重跑工具的候选判据（issue #48）。
 *
 * 这一组钉的是**"缺"怎么判**这一件事，而它的全部难度在于区分两种在库里长得一样的摘要：
 * - **没问过** L2/L3：JSON 里连 `impacts` / `changes` 这两个键都没有（那一次调用的提示词里
 *   还没有这两问）⇒ **要重跑**；
 * - **问过了、模型说没有**：键在、值是空数组 ⇒ **不缺**，重跑只会白花一次调用。
 *
 * 只按"空数组也算缺"来判的后果不是"多跑几条"，而是毁掉工具的**幂等**：一份本来就产不出
 * 改动对照的条目会被一遍遍清空重跑（每次都是一次境外调用）。所以这里刻意把两种形状分开钉。
 *
 * 判据住在 `.ts` 而不是脚本里，理由与本仓其余判据一字不差：脚本 `.mjs` 进不了单测、
 * 也进不了 pin 表，而**钉不住的判据等于没有判据**。
 */

/** 一份"什么都问过、也答得出来"的摘要（当前管线产出的形状）。 */
function completeSummary() {
  return {
    what: { text: '这是什么的摘要', quote: null, source: null },
    who: { text: '', quote: null, source: null },
    afterDeadline: { text: '', quote: null, source: null },
    keyPoints: [{ text: '条文要点', quote: '逐字原文', source: '某附件.docx', sourceUrl: null }],
    explanationPoints: [],
    impacts: [
      {
        quote: '收费公路在收费偿债期间的管理养护费用，在车辆通行费中列支。',
        who: '高速公路通行车主',
        point: '通行费用支出',
        text: '期限届满后可能继续收费。',
        kind: 'burden',
        source: '某附件.docx',
        sourceUrl: null,
      },
    ],
    changes: [{ clause: '第三十六条', kind: 'modify', text: '改了一处', quote: '逐字原文', source: '某附件.docx', sourceUrl: null }],
    changeMarkers: null,
    changeTable: null,
    explanationSections: null,
    deadline: { text: null, quote: null, source: null },
    howToComment: { text: '登录官网提交', quote: null, source: null },
    channels: [],
  };
}

function verdict(summary, extra = {}) {
  return redraftCandidate({ status: 'open', summaryModel: 'mimo-v2.5', summary, ...extra });
}

describe('issue #48：候选判据（缺 L2/L3 就算候选）', () => {
  it('**没有 `impacts` 键** ⇒ 候选，理由是"那次调用没问过 L3"（不是"模型没想到"）', () => {
    const summary = completeSummary();
    delete summary.impacts;
    const result = verdict(summary);
    assert.equal(result.candidate, true);
    assert.match(result.reason, /没问过 L3/, '键缺席的含义是确定的：那一次调用根本没问');
    assert.match(result.reason, /impacts/, '理由里要点名是哪一键缺席（读的人要能核对）');
  });

  it('**没有 `changes` 键** ⇒ 候选（同上，L2 那一侧）', () => {
    const summary = completeSummary();
    delete summary.changes;
    const result = verdict(summary);
    assert.equal(result.candidate, true);
    assert.match(result.reason, /没问过 L2/);
  });

  it('键在、值是**空数组** ⇒ 不候选（问过了、模型说没有 —— 再跑一次只是白花调用）', () => {
    const summary = completeSummary();
    summary.impacts = [];
    summary.changes = [];
    const result = verdict(summary);
    assert.equal(result.candidate, false, '这一条是"问过、没有"，不是"没问过"');
    assert.match(result.reason, /一件都不缺/);
  });

  it('一件都不缺（有带出处的要点 + 问过 L2/L3 + 判读是新形状）⇒ 跳过，工具因此可重复跑', () => {
    const result = verdict(completeSummary());
    assert.equal(result.candidate, false);
    assert.match(result.reason, /跳过/);
  });

  it('缺带出处的条文要点 ⇒ 候选（#67 那条原判据的语义一个字没改）', () => {
    const summary = completeSummary();
    summary.keyPoints = [{ text: '没有出处的要点', quote: '逐字原文', source: null, sourceUrl: null }];
    const result = verdict(summary);
    assert.equal(result.candidate, true);
    assert.match(result.reason, /缺条文要点/);
  });

  it('判读是**旧形状**（有判读却没有 `point` 键）⇒ 候选（6 条行业档存量正是这一类）', () => {
    const summary = completeSummary();
    summary.impacts = [
      {
        quote: '收费公路在收费偿债期间的管理养护费用，在车辆通行费中列支。',
        who: '高速公路通行车主、运输企业、收费站经营者', // #88 之前的长 who（带顿号）
        text: '期限届满后可能继续收费。',
        kind: 'burden',
        source: '某附件.docx',
        sourceUrl: null,
      },
    ];
    const result = verdict(summary);
    assert.equal(result.candidate, true);
    assert.match(result.reason, /旧形状|point/);
  });

  it('判读的 `point` 是**空串**（新形状、模型写不出方面）⇒ 不候选 —— 缺键与空值是两件事', () => {
    const summary = completeSummary();
    summary.impacts = [{ ...summary.impacts[0], point: '' }];
    assert.equal(verdict(summary).candidate, false);
  });
});

describe('issue #48：两条硬红线（不进候选）', () => {
  it('已截止 ⇒ 不候选（清了就永久失去摘要：摘要队列永远不会再拾起它）', () => {
    const result = verdict(completeSummary(), { status: 'closed' });
    assert.equal(result.candidate, false);
    assert.match(result.reason, /已截止/);
  });

  it('人工复核录入 ⇒ 不候选（重跑等于毁掉人的活）', () => {
    const result = verdict(completeSummary(), { summaryModel: MANUAL_SUMMARY_MODEL });
    assert.equal(result.candidate, false);
    assert.match(result.reason, /人工复核录入/);
  });

  it('硬红线的优先级高于"缺件"：既已截止又缺 L3 ⇒ 报已截止（不给一个会被误读的理由）', () => {
    const summary = completeSummary();
    delete summary.impacts;
    const result = verdict(summary, { status: 'closed' });
    assert.equal(result.candidate, false);
    assert.match(result.reason, /已截止/);
  });

  it('人工录入 + 缺件 ⇒ 报人工录入（否则读的人会以为"跑一遍就能补上"）', () => {
    const summary = completeSummary();
    delete summary.changes;
    const result = verdict(summary, { summaryModel: MANUAL_SUMMARY_MODEL });
    assert.equal(result.candidate, false);
    assert.match(result.reason, /人工复核录入/);
  });
});

describe('issue #48：读不出来的摘要算候选（页面上它本来就是占位）', () => {
  it('不是 JSON 对象 / 是数组 ⇒ 候选，理由说清"重跑是恢复它"', () => {
    for (const summary of [null, undefined, '不是对象', 42, []]) {
      const result = verdict(summary);
      assert.equal(result.candidate, true, `入参 ${JSON.stringify(summary)} 应当进候选`);
      assert.match(result.reason, /认不出形状/);
    }
  });

  it('缺必填段的 JSON（`parseQuotedSummary` 返回 null）⇒ 候选', () => {
    const result = verdict({ what: { text: '只有这一段' } });
    assert.equal(result.candidate, true);
    assert.match(result.reason, /必填段/);
  });

  it('空摘要字符串（列是空串）⇒ 候选而不是抛错', () => {
    const result = verdict('');
    assert.equal(result.candidate, true);
  });
});
