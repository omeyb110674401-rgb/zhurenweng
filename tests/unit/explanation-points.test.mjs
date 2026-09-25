import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildQuotedSummary, parseQuotedSummary } from '../../src/lib/summary-content.ts';
import {
  countExplanationSections,
  explanationCoverageVerdict,
  explanationSectionLines,
} from '../../src/lib/amendment-coverage.ts';

/**
 * 单元（issue #76 第 3 刀）：条文段落与说明段落**互相不能借用对方的引用**。
 *
 * 这块唯一要紧的事就是隔离。合在一起反查的话，一句其实出自《编制说明》的话会被
 * 标成"摘自官方原文的条文" —— 而读者正是按"规定本身"去读它的。生产实测有 13 条公示
 * 今天真的把说明喂进了摘要（说明中位 19,207 字），所以这不是假想风险。
 */

const DRAFT = {
  name: '某某法（修正草案征求意见稿）.docx',
  url: 'https://a/draft.docx',
  role: 'draft',
  text: '第二条 从事前款活动应当取得许可。',
};
const EXPLANATION = {
  name: '某某法（修正草案征求意见稿）编制说明.docx',
  url: 'https://a/expl.docx',
  role: 'explanation',
  text: [
    '一、修订的必要性',
    '现行许可制度实施以来存在申请材料重复的问题。',
    '二、主要修改内容',
    '增设一次性告知要求，减少重复提交。',
  ].join('\n'),   // 小节标题必须各占一行：这是行级判据（见下面的用例）
};

function base(overrides) {
  return {
    what: '就该法修正草案征求意见',
    who: '',
    whoCanSubmit: '',
    afterDeadline: '',
    deadline: null,
    howToComment: '登录官网提交',
    channels: [],
    ...overrides,
  };
}

describe('issue #76 第 3 刀：段落隔离', () => {
  it('条文要点必须出自条文段落：引用只在说明里 ⇒ 丢弃', () => {
    const summary = buildQuotedSummary(
      base({
        keyPoints: ['说明里讲的必要性'],

      }),
      { keyPoints: ['现行许可制度实施以来存在申请材料重复的问题。'] },
      [DRAFT, EXPLANATION],
    );
    assert.deepEqual(summary.keyPoints, [], '这句其实在说明里，不能标成条文要点');
  });

  it('说明要点必须出自说明段落：引用只在条文里 ⇒ 丢弃', () => {
    const summary = buildQuotedSummary(
      base({
        explanationPoints: [
          {
            heading: '一、修订的必要性',
            text: '因为现行制度有重复提交问题',
            quote: '第二条 从事前款活动应当取得许可。',
          },
        ],
      }),
      undefined,
      [DRAFT, EXPLANATION],
    );
    assert.deepEqual(summary.explanationPoints, []);
  });

  it('两边各归各位时都留下，出处分别指向各自附件', () => {
    const summary = buildQuotedSummary(
      base({
        keyPoints: ['须取得许可'],
        explanationPoints: [
          {
            heading: '一、修订的必要性',
            text: '现行制度存在重复提交问题',
            quote: '现行许可制度实施以来存在申请材料重复的问题。',
          },
        ],
      }),
      { keyPoints: ['第二条 从事前款活动应当取得许可。'] },
      [DRAFT, EXPLANATION],
      null,
      countExplanationSections(EXPLANATION.text),
    );
    assert.equal(summary.keyPoints.length, 1);
    assert.equal(summary.keyPoints[0].source, DRAFT.name);
    assert.equal(summary.explanationPoints.length, 1);
    assert.equal(summary.explanationPoints[0].source, EXPLANATION.name);
    assert.equal(summary.explanationSections, 2);
  });

  it('说明小节缺引用或缺说明就整条不要（页面上不留无从核对的行）', () => {
    const summary = buildQuotedSummary(
      base({
        explanationPoints: [
          // 引用**必须是真的能在夹具说明里找到的句子** —— 否则这一条会被"反查不到"顺手
          // 丢掉，测的就不再是这个守卫（自证门第一轮就是这样抓到这条假绿灯的）。
          { heading: '一、修订的必要性', text: '', quote: '现行许可制度实施以来存在申请材料重复的问题。' },
          { heading: '二、主要修改内容', text: '增设一次性告知要求', quote: '' },
        ],
      }),
      undefined,
      [DRAFT, EXPLANATION],
    );
    assert.deepEqual(summary.explanationPoints, []);
  });
  it('没带 role 的旧调用方按条文侧处理（向后兼容，不会静默丢要点）', () => {
    const legacy = [{ name: DRAFT.name, url: DRAFT.url, text: DRAFT.text }];
    const summary = buildQuotedSummary(
      base({ keyPoints: ['须取得许可'] }),
      { keyPoints: ['第二条 从事前款活动应当取得许可。'] },
      legacy,
    );
    assert.equal(summary.keyPoints.length, 1);
    assert.equal(summary.explanationPoints.length, 0);
    assert.equal(summary.explanationSections, null);
  });
});

describe('issue #76 第 3 刀：小节计数与那句话', () => {
  it('列出四种官方写法，正文行与附行都不算标题', () => {
    const lines = [
      '一、项目概况',
      '1 编制背景与任务来源',
      '（二）工作过程',
      '第二章 必要性分析',
      '本节说明本项目在现行制度下存在的问题，因此需要修订相关条款并重新发布实施。',
      '附：意见汇总表',
    ];
    const text = lines.join('\n');
    assert.deepEqual(explanationSectionLines(text), lines.slice(0, 4));
    assert.equal(countExplanationSections(text), 4);
    // 行级判据：整篇挤成一行时谁都不算小节标题 —— 宁可数不出来，也不靠子串猜出个假分母
    assert.deepEqual(explanationSectionLines(lines.join(' ')), []);
  });
  it('分母为 0 时不写"已列出全部 0 个"', () => {
    assert.equal(explanationCoverageVerdict(0, 0).state, 'no_markers');
  });

  it('措辞带"约"：这一层是启发式，不假装精确', () => {
    assert.match(explanationCoverageVerdict(2, 5).detail, /约 5 个小节/);
    assert.match(explanationCoverageVerdict(5, 5).detail, /约 5 个小节/);
  });
});

describe('issue #76 第 3 刀：落库与读回', () => {
  it('旧行没有这两个字段照样解析（不能让存量掉回占位）', () => {
    const parsed = parseQuotedSummary({
      what: { text: '甲', quote: '' },
      deadline: { text: null, quote: null },
      howToComment: { text: '乙', quote: '' },
    });
    assert.deepEqual(parsed.explanationPoints, []);
    assert.equal(parsed.explanationSections, null);
  });

  it('能落库就能读回，脏条目丢掉', () => {
    const built = buildQuotedSummary(
      base({
        explanationPoints: [
          { heading: '一、必要性', text: '有重复提交问题', quote: '现行许可制度实施以来存在申请材料重复的问题。' },
          { heading: '二、修改内容', text: '', quote: '增设一次性告知要求，减少重复提交。' },
        ],
      }),
      undefined,
      [DRAFT, EXPLANATION],
      null,
      2,
    );
    const round = parseQuotedSummary(JSON.parse(JSON.stringify(built)));
    assert.equal(round.explanationPoints.length, 1);
    assert.equal(round.explanationPoints[0].heading, '一、必要性');
    assert.equal(round.explanationSections, 2);
  });
});
