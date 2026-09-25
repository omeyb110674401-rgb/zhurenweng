import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  changeCoverageVerdict,
  countChangeMarkers,
} from '../../src/lib/amendment-coverage.ts';
import { buildQuotedSummary, parseQuotedSummary } from '../../src/lib/summary-content.ts';

/**
 * 单元（issue #76 第 2 刀）：改动点的"能不能落库"与覆盖度那句话怎么写。
 *
 * 要钉住的是三件事，每件都是"页面会撒谎"的形状：
 *   1. 反查不到出处的改动**整行丢弃** —— 留着它，页面就在为一行核对不上的话背书；
 *   2. 分母为 0 时不许写"已列出全部 0 处" —— 那会让读者以为这条公示没改什么；
 *   3. 列得比分母少要照实说少 —— "以上是主要修改内容"这种收尾等于把截藏起来。
 */

const SOURCES = [
  {
    name: '某某法（修正草案）.docx',
    url: 'https://a.test/amend.docx',
    text: '第二条修改为：从事前款活动应当取得许可。\n删去第七条第二款。',
  },
];

function base(overrides = {}) {
  return {
    what: '就该法修正草案征求意见',
    who: '',
    whoCanSubmit: '社会各界',
    afterDeadline: '',
    deadline: '2026-11-30',
    howToComment: '登录官网提交',
    channels: [],
    ...overrides,
  };
}

describe('issue #76：改动点必须逐字反查得到出处', () => {
  it('引用命中条文的留下，并带出出处附件', () => {
    const summary = buildQuotedSummary(
      base({
        changes: [
          {
            clause: '第二条',
            kind: 'modify',
            text: '取得许可后方可从事',
            quote: '第二条修改为：从事前款活动应当取得许可。',
          },
        ],
      }),
      undefined,
      SOURCES,
    );
    assert.equal(summary.changes.length, 1);
    assert.equal(summary.changes[0].source, '某某法（修正草案）.docx');
    assert.equal(summary.changes[0].kind, 'modify');
  });

  it('引用在条文里找不到的整行丢弃（模型改写或凭空概括）', () => {
    const summary = buildQuotedSummary(
      base({
        changes: [
          { clause: '第九条', kind: 'add', text: '新增备案要求', quote: '第九条 应当办理备案手续。' },
        ],
      }),
      undefined,
      SOURCES,
    );
    assert.deepEqual(summary.changes, [], '这一行没有可核对的出处，不该出现在页面上');
  });

  it('缺 quote 或缺说明的行直接不要；不认识的类型归 other', () => {
    const summary = buildQuotedSummary(
      base({
        changes: [
          { clause: '第七条', kind: 'delete', text: '', quote: '删去第七条第二款。' },
          { clause: '第七条', kind: 'delete', text: '删掉一款', quote: '' },
          { clause: '第七条', kind: '撤销', text: '删掉一款', quote: '删去第七条第二款。' },
        ],
      }),
      undefined,
      SOURCES,
    );
    assert.equal(summary.changes.length, 1);
    assert.equal(summary.changes[0].kind, 'other', '类型不在词表里要落到 other，不能原样入库');
  });

  it('没给条文输入时改动点必然为空（不变量不依赖模型是否听话）', () => {
    const summary = buildQuotedSummary(
      base({ changes: [{ clause: '第二条', kind: 'modify', text: 'x', quote: '第二条修改为：从事前款活动应当取得许可。' }] }),
    );
    assert.deepEqual(summary.changes, []);
  });
});

describe('issue #76：覆盖度那句话的三种写法', () => {
  it('数到的改动表述为 0 时，不许写成"已列出全部 0 处"', () => {
    const verdict = changeCoverageVerdict(0, countChangeMarkers('一份没有修改表述的正文'));
    assert.equal(verdict.state, 'no_markers');
    assert.doesNotMatch(verdict.detail, /全部 0/);
  });

  it('列得比分母少要照实说少', () => {
    const markers = countChangeMarkers('第二条修改为甲。删去第七条。增加一条，作为第八条。');
    // 一句"增加一条，作为第八条"同时是新增与条序调整：数的是"有多少处表述要解释"，
    // 不是"改了几条"，所以这里本来就是 4 处。
    assert.equal(markers.total, 4);
    assert.equal(markers.byKind.renumber, 1);
    const verdict = changeCoverageVerdict(2, markers);
    assert.equal(verdict.state, 'partial');
    assert.match(verdict.detail, /检测到 4 处修改表述，本页列出 2 处/);
  });

  it('列够了才说"全部"', () => {
    const markers = countChangeMarkers('第二条修改为甲。删去第七条。');
    assert.equal(changeCoverageVerdict(2, markers).state, 'complete');
    assert.equal(changeCoverageVerdict(5, markers).state, 'complete');
  });
});

describe('issue #76：落库形状的向后兼容', () => {
  it('旧行没有 changes / changeMarkers 也照样解析（不能让存量掉回占位）', () => {
    const old = {
      what: { text: '甲', quote: 'a' },
      who: { text: '', quote: null },
      whoCanSubmit: { text: '', quote: null },
      afterDeadline: { text: '', quote: null },
      keyPoints: [],
      deadline: { text: null, quote: null },
      howToComment: { text: '登录官网', quote: 'b' },
      channels: [],
    };
    const parsed = parseQuotedSummary(old);
    assert.deepEqual(parsed.changes, []);
    assert.equal(parsed.changeMarkers, null);
  });

  it('脏条目丢掉，好条目留下', () => {
    const parsed = parseQuotedSummary({
      what: { text: '甲', quote: '' },
      deadline: { text: null, quote: null },
      howToComment: { text: '乙', quote: '' },
      changes: [
        null,
        { clause: '第二条', kind: 'modify', text: '改了什么', quote: '' },
        { clause: '第二条', kind: 'weird', text: '改了什么', quote: '第二条修改为甲' },
      ],
      changeMarkers: { total: 7, byKind: { modify: 4, add: 1, delete: 2 } },
    });
    assert.equal(parsed.changes.length, 1);
    assert.equal(parsed.changes[0].kind, 'other');
    assert.equal(parsed.changeMarkers?.total, 7);
    assert.equal(parsed.changeMarkers?.byKind.renumber, 0, '缺的类别补 0，不能让页面显示 undefined');
  });

  it('total 不是数字就当没数过', () => {
    const parsed = parseQuotedSummary({
      what: { text: '甲', quote: '' },
      deadline: { text: null, quote: null },
      howToComment: { text: '乙', quote: '' },
      changeMarkers: { total: '很多' },
    });
    assert.equal(parsed.changeMarkers, null);
  });
});
