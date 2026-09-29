import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeModelSummary } from '../../src/lib/adapters/openai-compatible-llm.ts';
import {
  buildQuotedSummary,
  buildQuotedSummaryWithTally,
  parseQuotedSummary,
} from '../../src/lib/summary-content.ts';
import {
  CHANGE_KIND_LABELS,
  changeCoverageVerdict,
  countChangeMarkers,
  findChangeMarkers,
} from '../../src/lib/change-coverage.ts';

/**
 * 单元：「改了哪几处」（issue #86 第 2 刀）。
 *
 * 这一段是**重建**：同样的内容 #76 实现过、上过线，2026-09-27 因"从未产出过"被整体删除
 * （issue #85），而那个判据是错的 —— 那 5 条候选从来没有被带这段代码的版本重跑过，
 * 用旧提示词重跑金丝雀一次就吐出 10 条、8 条通过逐字反查（86-*.md 第九节）。
 *
 * 所以这一组测试**大部分是从被删掉的 `amendment-changes.test.mjs` 里搬回来的**
 * （那些不变量当年就是对的，删功能不该把它们的覆盖一起带走 —— #85 自己也立过这条规矩），
 * 外加**三处地基改动**的钉子：
 * ① 引用可以在任何一份附件里反查（旧实现只认条文侧）；
 * ② 不按体裁门控，改判"有没有可核对的依据"；
 * ③ 逐字反查容忍省略号（在 summary-impacts.test.mjs 里单独钉）。
 */

const QUOTE_CHANGE = '将第三十六条修改为：国家采用依法征税的办法筹集公路管理养护资金。';
const DRAFT = {
  name: '某某法（修正草案征求意见稿）.docx',
  url: 'https://www.gov.cn/draft.docx',
  text: `一、${QUOTE_CHANGE}\n二、删去第七条第二款，相应调整条文序号。`,
};
const EXPLANATION = {
  name: '某某法（修正草案征求意见稿）编制说明.docx',
  url: 'https://www.gov.cn/explain.docx',
  text: '二、主要修改内容 与现行做法相比，删去了实践中已无法执行的两项前置条件，其余为编辑性修改。',
  role: 'explanation',
};
const EXPLANATION_QUOTE = '与现行做法相比，删去了实践中已无法执行的两项前置条件';
const ABSENT = '这句话不在任何一份附件里出现过';

function summaryWith(parts) {
  return {
    what: '这是什么',
    who: '',
    whoCanSubmit: '',
    afterDeadline: '',
    deadline: null,
    howToComment: '如何提意见',
    channels: [],
    ...parts,
  };
}

function changeOf(overrides = {}) {
  return {
    clause: '第三十六条',
    kind: 'modify',
    text: '养护资金改由依法征税筹集',
    quote: QUOTE_CHANGE,
    ...overrides,
  };
}

describe('issue #86：改动点必须逐字反查得到出处', () => {
  it('引用命中正文 ⇒ 落库，出处与类型由程序判定', () => {
    const { summary, tally } = buildQuotedSummaryWithTally(
      summaryWith({ changes: [changeOf()] }),
      undefined,
      [DRAFT],
    );
    assert.equal(summary.changes.length, 1);
    assert.equal(summary.changes[0].source, DRAFT.name, '出处是程序反查的，不是模型自报的');
    assert.equal(summary.changes[0].sourceUrl, DRAFT.url);
    assert.equal(tally.quoteNotFound, 0);
  });

  it('**引用只在编制说明里命中 ⇒ 也落库**（与旧实现相反：实测显示两类文件的依据落在不同侧）', () => {
    const { summary, tally } = buildQuotedSummaryWithTally(
      summaryWith({ changes: [changeOf({ quote: EXPLANATION_QUOTE })] }),
      undefined,
      [DRAFT, EXPLANATION],
    );
    assert.equal(summary.changes.length, 1, '只认条文侧就会把这一类全丢掉');
    assert.equal(summary.changes[0].source, EXPLANATION.name);
    assert.equal(tally.quoteNotFound, 0);
  });

  it('反查不到 ⇒ 整行丢弃，且计数 +1（丢掉的行要留痕迹，改动点当年就是这么死的）', () => {
    const { summary, tally } = buildQuotedSummaryWithTally(
      summaryWith({ changes: [changeOf(), changeOf({ quote: ABSENT })] }),
      undefined,
      [DRAFT],
    );
    assert.equal(summary.changes.length, 1);
    assert.equal(tally.quoteNotFound, 1);
  });

  it('缺 quote 或缺 text ⇒ 丢弃，但不计入反查失败（那是归一化阶段的账）', () => {
    const { summary, tally } = buildQuotedSummaryWithTally(
      summaryWith({ changes: [{ clause: 'X', kind: 'modify', text: '有说明没引用' }] }),
      undefined,
      [DRAFT],
    );
    assert.equal(summary.changes.length, 0);
    assert.equal(tally.quoteNotFound, 0);
  });

  it('原文没写条号 ⇒ clause 为空也保留（页面留破折号，而不是让模型去编一个编号）', () => {
    const { summary } = buildQuotedSummaryWithTally(
      summaryWith({ changes: [changeOf({ clause: '' })] }),
      undefined,
      [DRAFT],
    );
    assert.equal(summary.changes.length, 1);
    assert.equal(summary.changes[0].clause, '');
  });

  it('认不出的类型落 other（不硬塞成"修改"）', () => {
    const { summary } = buildQuotedSummaryWithTally(
      summaryWith({ changes: [changeOf({ kind: '莫名其妙的值' })] }),
      undefined,
      [DRAFT],
    );
    assert.equal(summary.changes[0].kind, 'other');
    assert.equal(CHANGE_KIND_LABELS.other, '其他');
  });

  it('没有给出附件（后台人工录入 / 影子档）⇒ 一律不落库（不依赖模型听话）', () => {
    const summary = buildQuotedSummary(summaryWith({ changes: [changeOf()] }), undefined, []);
    assert.equal(summary.changes.length, 0);
  });
});

describe('issue #86：归一化阶段的上限与空值（改动点）', () => {
  it('超过 40 处 ⇒ 超上限计数 = 多出来的条数', () => {
    const tally = { emptyOrInvalid: 0, overLimit: 0 };
    const changes = Array.from({ length: 43 }, (_, index) =>
      changeOf({ clause: `第${index + 1}条`, quote: `${QUOTE_CHANGE}${index}` }),
    );
    const summary = normalizeModelSummary(
      summaryWith({ what: '这是什么', howToComment: '如何提意见', changes }),
      tally,
    );
    assert.equal(summary.changes.length, 40);
    assert.equal(tally.overLimit, 3);
  });

  it('空条目 / 类型不对 ⇒ 计入空值那一类；一条都不合格时字段整个不出现', () => {
    const tally = { emptyOrInvalid: 0, overLimit: 0 };
    const summary = normalizeModelSummary(
      summaryWith({
        what: '这是什么',
        howToComment: '如何提意见',
        changes: [null, '不是对象', { clause: 'X', kind: 'modify', text: '没引用' }],
      }),
      tally,
    );
    assert.equal(summary.changes, undefined);
    assert.equal(tally.emptyOrInvalid, 3);
  });
});

describe('issue #86：覆盖度那三句话（分母是全文，不是喂进去的那一截）', () => {
  it('一处在正文里也数不到 ⇒ 不说"全部 0 处"', () => {
    const verdict = changeCoverageVerdict(0, countChangeMarkers('这份文件里没有任何改动表述。'));
    assert.equal(verdict.state, 'no_markers');
    assert.doesNotMatch(verdict.detail, /全部 0/);
  });

  it('列得比数到的少 ⇒ 照实说少，且**不替差额认领原因**（2026-09-28 实测：那句话曾经是假的）', () => {
    const markers = countChangeMarkers(DRAFT.text);
    assert.ok(markers.total >= 2, `夹具里该数得到改动表述，实际 ${markers.total}`);
    const verdict = changeCoverageVerdict(1, markers);
    assert.equal(verdict.state, 'partial');
    assert.match(verdict.detail, new RegExp(`检测到 ${markers.total} 处`));
    assert.match(verdict.detail, /本页列出 1 处/);
    // 分母是什么、表里为什么只有这些 —— 这两件是我们真的知道的
    assert.match(verdict.detail, /检测按本站读到的全部附件正文数/);
    assert.match(verdict.detail, /表里只列模型写出、且引用能逐字对回原文的那些/);
    // 差额的两种可能都要说出来，而不是只挑"本站没读到"那一种
    assert.match(verdict.detail, /差额既可能来自模型没写/);
    assert.match(verdict.detail, /也可能来自本站没读到的那部分/);
    // 反例：公路法那条正文整份都在窗口内，同一输入四遍列出 8/2/3/8 行 ⇒ "没读到"不是通解
    assert.doesNotMatch(verdict.detail, /其余的不在本站读到的那一截/);
  });

  it('列够了才说"全部"', () => {
    const markers = countChangeMarkers(DRAFT.text);
    const verdict = changeCoverageVerdict(markers.total, markers);
    assert.equal(verdict.state, 'complete');
    assert.match(verdict.detail, new RegExp(`全部 ${markers.total} 处`));
  });

  it('同一句里的多处表述各数一次（「增加一条，作为第八条」既是新增也是条序调整）', () => {
    const markers = countChangeMarkers('三、增加一条，作为第八条：主管部门应当建立信用记录制度。');
    assert.equal(markers.byKind.add, 1);
    assert.equal(markers.byKind.renumber, 1);
    assert.equal(markers.total, 2, '读者关心的是"有多少处表述要解释"，不是"改了几条"');
  });

  it('逐处找出来的位置与字面：总数与 countChangeMarkers 同源，且**一句话可以是三处**', () => {
    // 这条用例存在的理由是个真实事故（差点发生）：`total` 是**覆盖度的分母**，不是"改了几条"。
    // 2026-09-28 写"把数到的每一处都列成行"那个方案时我按 14 处 = 14 行去想了 —— 而这一句
    // 就能数出三处。把它钉住，是为了让下一个人先看到"分母 ≠ 条款数"。
    const sentence = '删去第七条，增加一条，作为第八条。';
    const found = findChangeMarkers(sentence);
    assert.deepEqual(
      found.map((marker) => marker.kind),
      ['delete', 'add', 'renumber'],
      '按位置升序返回，类型各算一处',
    );
    assert.deepEqual(
      found.map((marker) => marker.text),
      ['删去', '增加一条', '作为第八条'],
      '字面照抄命中片段，不去改写',
    );
    const [first, second, third] = found;
    assert.ok(first.index < second.index && second.index < third.index, '位置升序');
    // 与 countChangeMarkers 同源：一个是逐处、一个是汇总，不许各算一套
    assert.equal(countChangeMarkers(sentence).total, found.length);
    assert.equal(countChangeMarkers('这份文件里没有任何改动表述。').total, 0);
    assert.deepEqual(findChangeMarkers(''), []);
  });
});

describe('issue #86：落库形状与三种历史行', () => {
  it('build → parse 等价（含改动点与分母）', () => {
    const built = buildQuotedSummary(
      summaryWith({ changes: [changeOf()] }),
      undefined,
      [DRAFT],
      null,
      countChangeMarkers(DRAFT.text),
    );
    const parsed = parseQuotedSummary(JSON.parse(JSON.stringify(built)));
    assert.deepEqual(parsed, built);
  });

  it('**#85 之前落库的旧行**（changes 是空数组、changeMarkers 为 null）照常解析', () => {
    // 生产库里真有 5 行是这个形状（它们是 #81 重跑的那批），这一段删过又装回来，必须吃得下
    const legacy = JSON.parse(
      JSON.stringify(buildQuotedSummary(summaryWith({ keyPoints: ['要点'] }), { keyPoints: [QUOTE_CHANGE] }, [DRAFT])),
    );
    legacy.changes = [];
    legacy.changeMarkers = null;
    const parsed = parseQuotedSummary(legacy);
    assert.ok(parsed);
    assert.deepEqual(parsed.changes, []);
    assert.equal(parsed.changeMarkers, null);
  });

  it('压根没有这两个键的老老行也照常解析（存量 84 条里的大多数）', () => {
    const legacy = JSON.parse(
      JSON.stringify(buildQuotedSummary(summaryWith({ keyPoints: ['要点'] }), { keyPoints: [QUOTE_CHANGE] }, [DRAFT])),
    );
    delete legacy.changes;
    delete legacy.changeMarkers;
    const parsed = parseQuotedSummary(legacy);
    assert.ok(parsed, '缺键绝不能让存量条目掉回「待人工复核」占位');
    assert.deepEqual(parsed.changes, []);
    assert.equal(parsed.changeMarkers, null);
  });

  it('分母脏了只当没数过（total 不是数字 ⇒ null），不打断整页', () => {
    const built = buildQuotedSummary(summaryWith({ changes: [changeOf()] }), undefined, [DRAFT]);
    const raw = JSON.parse(JSON.stringify(built));
    raw.changeMarkers = { total: '三处' };
    assert.equal(parseQuotedSummary(raw).changeMarkers, null);
  });
});
