import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildQuotedSummary, parseQuotedSummary } from '../../src/lib/summary-content.ts';
import {
  countExplanationSections,
  explanationCoverageVerdict,
  explanationSectionLines,
} from '../../src/lib/explanation-coverage.ts';

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
    assert.doesNotMatch(explanationCoverageVerdict(0, 0).detail, /全部 0/);
  });

  it('列得比数到的少要照实说少（不再替差额认领"我们没读到"）', () => {
    const verdict = explanationCoverageVerdict(2, 6);
    assert.equal(verdict.state, 'partial');
    assert.match(verdict.detail, /检测到约 6 个小节，本页列出 2 个/);
    assert.match(verdict.detail, /检测按本站读到的说明正文数/);
    // 没有喂入清单就没有答案可给：照实说说不清，而不是把差额推给"我们没读到"（§19.4）
    assert.match(verdict.detail, /没有留下本轮的喂入记录/);
    assert.doesNotMatch(verdict.detail, /其余的不在本站读到的那一截/);
    assert.doesNotMatch(verdict.detail, /没喂进去的那一截/);
  });

  it('列够了才说"全部"（多列出不算少）', () => {
    assert.equal(explanationCoverageVerdict(6, 6).state, 'complete');
    assert.equal(explanationCoverageVerdict(9, 6).state, 'complete');
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
      2,
    );
    const round = parseQuotedSummary(JSON.parse(JSON.stringify(built)));
    assert.equal(round.explanationPoints.length, 1);
    assert.equal(round.explanationPoints[0].heading, '一、必要性');
    assert.equal(round.explanationSections, 2);
  });
});

/** 一份喂入清单（形状 = `summary_diagnostics_json.feed`，见 src/lib/summary-diagnostics.ts）。 */
const feedOf = (overrides = {}) => ({
  tier: 'deep',
  budget: { perSource: 16_000, total: 24_000, minShare: 4_000 },
  usedCjk: 0,
  sources: [],
  starved: [],
  ...overrides,
});

const fedSource = (overrides = {}) => ({
  name: EXPLANATION.name,
  role: 'explanation',
  origin: 'attachment',
  fullCjk: 12_400,
  fedCjk: 2_753,
  chars: 8_000,
  allowance: 8_000,
  truncated: false,
  ...overrides,
});

/**
 * issue #86 §19.4 收尾：**差额能归给谁，由本轮的喂入清单说了算**（不再是猜）。
 *
 * 从前这一栏写「其余的不在本站读到的那一截里」，而实测里那句话是假的：说明整份都在喂入
 * 窗口内（`truncated` 全为 false），模型仍然只列出三分之一的小节。所以这一组钉两件相反的
 * 事 —— 清单报了截断 ⇒ 必须说清读到几份、几份被截；清单说没截 ⇒ **一个字都不许再提"没读到"**。
 * 判据全在 `coverageGapAttribution` / `feedReportedGap`（本文件与 change-coverage.ts 共用）。
 */
describe('issue #86 §19.4：喂入清单说差额在哪（编制说明那一栏）', () => {
  it('清单说有一份被截 ⇒ 说清读到几份、几份被截，并把"那一截"作为一种可能说出来', () => {
    const verdict = explanationCoverageVerdict(
      1,
      3,
      feedOf({ usedCjk: 2_753, sources: [fedSource({ truncated: true })] }),
    );
    assert.equal(verdict.state, 'partial');
    assert.match(verdict.detail, /检测到约 3 个小节，本页列出 1 个/);
    assert.match(verdict.detail, /本轮读到 1 份说明类来源，共喂进模型 2753 个汉字/);
    assert.match(verdict.detail, /其中 1 份只喂进一部分（被截）/);
    assert.match(verdict.detail, /差额可能出在没喂进去的那一截上/);
  });

  it('清单说每一份都整份进了窗口 ⇒ 不许再提"没读到"，差额归给模型没写', () => {
    const detail = explanationCoverageVerdict(
      1,
      3,
      feedOf({ usedCjk: 2_753, sources: [fedSource()] }),
    ).detail;
    assert.match(detail, /本轮读到 1 份说明类来源/);
    assert.match(detail, /每一份都整份进了窗口，没有一份被截/);
    assert.match(detail, /差额来自模型没有把检测到的说明小节都写出来/);
    // 这一刀修的就是这两句：窗口没截，差额只能归给模型（实测：模型只列了三分之一）
    assert.doesNotMatch(detail, /其余的不在本站读到的那一截/);
    assert.doesNotMatch(detail, /没喂进去的那一截/);
    assert.doesNotMatch(detail, /本站没读到/);
  });

  it('被截的是条文类附件 ⇒ 编制说明这一栏不许跟着说"被截"（那会读成说明被截）', () => {
    const feed = feedOf({
      sources: [
        fedSource(),
        fedSource({ name: DRAFT.name, role: 'draft', truncated: true }),
      ],
    });
    const detail = explanationCoverageVerdict(1, 3, feed).detail;
    assert.match(detail, /本轮读到 1 份说明类来源/);
    assert.match(detail, /没有一份被截/);
    assert.doesNotMatch(detail, /只喂进一部分/);
    assert.doesNotMatch(detail, /没喂进去的那一截/);
  });

  it('说明类里有一份一个字都没喂进去 ⇒ 也要说，并允许把差额指向那一截', () => {
    const feed = feedOf({
      sources: [fedSource()],
      starved: [{ name: '某某法（修正草案征求意见稿）起草说明.docx', fullCjk: 6_000 }],
    });
    const detail = explanationCoverageVerdict(1, 3, feed).detail;
    assert.match(detail, /本轮读到 2 份说明类来源/);
    assert.match(detail, /其中 1 份一个字都没喂进去/);
    assert.match(detail, /差额可能出在没喂进去的那一截上/);
  });

  it('没有喂入清单（v1 的存量行）⇒ 不猜，也不说"我们没读到"', () => {
    for (const feed of [null, undefined]) {
      const detail = explanationCoverageVerdict(1, 3, feed).detail;
      assert.match(detail, /没有留下本轮的喂入记录/);
      assert.doesNotMatch(detail, /没喂进去的那一截/);
      assert.doesNotMatch(detail, /本站没读到/);
    }
  });
});
