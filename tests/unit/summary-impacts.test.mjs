import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SYSTEM_PROMPT, normalizeModelSummary } from '../../src/lib/adapters/openai-compatible-llm.ts';
import {
  IMPACT_KIND_LABELS,
  buildQuotedSummary,
  buildQuotedSummaryWithTally,
  findDraftSourceForQuote,
  parseQuotedSummary,
  quoteSegments,
} from '../../src/lib/summary-content.ts';
import { shouldRenderImpacts } from '../../src/lib/impact-display.ts';

/**
 * 单元：影响判读（issue #86 第 1 刀）与**容忍省略号的逐字反查**。
 *
 * 这一组测试针对的是本站唯一一段**允许推断**的内容，所以钉的几乎全是"不许放水"：
 * 1. 省略号容忍**只放宽"中间有省略"这一种形状**，不放过任何一截对不上的引用 ——
 *    这是 2026-09-27 实验量出来的真实损失（旧提示词重跑金丝雀，10 条里 2 条因省略号被丢）。
 * 2. 判读的引用可以在**任何一份**附件里反查（不做段落隔离，理由见 buildImpacts）——
 *    而 keyPoints / explanationPoints 的隔离**一个字都没松**（同一份测试里对照着钉）。
 * 3. 反查不到的**整条不落库**，且这件事要**数得出来**（tally）——否则下一代人又要靠猜。
 */

const QUOTE_A = '运输机场运营人应当取得许可';
const QUOTE_B = '为了规范运输机场运营许可';
const ABSENT = '这句话不在任何一份附件的正文里面';
const DRAFT = {
  name: '运输机场运营许可规定（征求意见稿）.docx',
  url: 'https://www.gov.cn/draft.docx',
  text: `第一条 ${QUOTE_B}，制定本规定。第二条 ${QUOTE_A}。`,
};
const EXPLANATION = {
  name: '编制说明.docx',
  url: 'https://www.gov.cn/explanation.docx',
  text: '一、项目概况 本次修订删去了实践中无法执行的两项前置条件，其余为编辑性修改。',
  role: 'explanation',
};
const EXPLANATION_LINE = '本次修订删去了实践中无法执行的两项前置条件';

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

describe('issue #86：逐字反查要容忍省略号（但不许放水）', () => {
  it('没有省略号时行为与从前一致：命中 / 不命中', () => {
    assert.equal(findDraftSourceForQuote(QUOTE_A, [DRAFT])?.name, DRAFT.name);
    assert.equal(findDraftSourceForQuote(ABSENT, [DRAFT]), null);
  });

  it('中间带中文省略号 ⇒ 命中（每一截都逐字）', () => {
    const quote = `${QUOTE_B}……${QUOTE_A}`;
    assert.equal(findDraftSourceForQuote(quote, [DRAFT])?.name, DRAFT.name);
  });

  it('中间带 ASCII 省略号 ⇒ 也命中（模型两种都写）', () => {
    const quote = `${QUOTE_B}...${QUOTE_A}`;
    assert.equal(findDraftSourceForQuote(quote, [DRAFT])?.name, DRAFT.name);
  });

  it('**某一截对不上就不许命中** —— 容忍的是省略，不是对不上', () => {
    const quote = `${QUOTE_B}……${ABSENT}`;
    assert.equal(findDraftSourceForQuote(quote, [DRAFT]), null);
  });

  it('两截都在、但顺序颠倒 ⇒ 不命中（引用要按原文先后）', () => {
    const quote = `${QUOTE_A}……${QUOTE_B}`;
    assert.equal(findDraftSourceForQuote(quote, [DRAFT]), null);
  });

  it('有一截短于 8 字 ⇒ 不命中（否则「第一条…第二条」能蒙中任何公文）', () => {
    const quote = `第一条……${QUOTE_A}`;
    assert.equal(findDraftSourceForQuote(quote, [DRAFT]), null);
  });

  it('只有省略号 ⇒ 不命中', () => {
    assert.equal(findDraftSourceForQuote('………', [DRAFT]), null);
    assert.equal(findDraftSourceForQuote('...', [DRAFT]), null);
  });

  it('quoteSegments 把三种省略号写法都切开、并丢掉空段', () => {
    assert.deepEqual(quoteSegments('甲甲甲甲……乙乙乙乙'), ['甲甲甲甲', '乙乙乙乙']);
    assert.deepEqual(quoteSegments('甲甲甲甲...乙乙乙乙'), ['甲甲甲甲', '乙乙乙乙']);
    assert.deepEqual(quoteSegments('甲甲甲甲…乙乙乙乙'), ['甲甲甲甲', '乙乙乙乙']);
    assert.deepEqual(quoteSegments('甲甲甲甲'), ['甲甲甲甲']);
  });
});

describe('issue #86：影响判读必须挂得住原文', () => {
  it('引用命中条文侧 ⇒ 落库，出处由程序算出来', () => {
    const { summary, tally } = buildQuotedSummaryWithTally(
      summaryWith({
        impacts: [{ quote: QUOTE_A, who: '运输机场运营人', text: '可能增加取证成本', kind: 'burden' }],
      }),
      undefined,
      [DRAFT],
    );
    assert.equal(summary.impacts.length, 1);
    assert.equal(summary.impacts[0].source, DRAFT.name, '出处是程序反查的，不是模型自报的');
    assert.equal(summary.impacts[0].sourceUrl, DRAFT.url);
    assert.equal(tally.quoteNotFound, 0);
  });

  it('引用命中**编制说明**侧 ⇒ 也落库（这一段刻意不做段落隔离）', () => {
    const { summary } = buildQuotedSummaryWithTally(
      summaryWith({
        impacts: [{ quote: EXPLANATION_LINE, who: '', text: '可能放松前置条件', kind: 'risk' }],
      }),
      undefined,
      [DRAFT, EXPLANATION],
    );
    assert.equal(summary.impacts.length, 1, '法律草案的对照句在正文里、标准那批在说明里，只认一侧会白丢一半');
    assert.equal(summary.impacts[0].source, EXPLANATION.name);
  });

  it('对照：条文要点的段落隔离**一个字都没松**（说明里的话进不了 keyPoints）', () => {
    const { summary, tally } = buildQuotedSummaryWithTally(
      summaryWith({ keyPoints: ['拿说明冒充条文'] }),
      { keyPoints: [EXPLANATION_LINE] },
      [DRAFT, EXPLANATION],
    );
    assert.equal(summary.keyPoints.length, 0);
    assert.equal(tally.quoteNotFound, 1);
  });

  it('引用两侧都反查不到 ⇒ 整条不落库，且计数 +1', () => {
    const { summary, tally } = buildQuotedSummaryWithTally(
      summaryWith({ impacts: [{ quote: ABSENT, who: '', text: '推断', kind: 'risk' }] }),
      undefined,
      [DRAFT],
    );
    assert.equal(summary.impacts.length, 0, '没有引用的推断不许上页面');
    assert.equal(tally.quoteNotFound, 1);
  });

  it('缺 quote 或缺 text ⇒ 丢弃，但**不计入**反查失败（那是归一化阶段的账）', () => {
    const { summary, tally } = buildQuotedSummaryWithTally(
      summaryWith({
        impacts: [
          { quote: '', who: '', text: '推断', kind: 'risk' },
          { quote: QUOTE_A, who: '', text: '', kind: 'risk' },
        ],
      }),
      undefined,
      [DRAFT],
    );
    assert.equal(summary.impacts.length, 0);
    assert.equal(tally.quoteNotFound, 0, '两种原因的处置完全不同，不能混进同一个计数器');
  });

  it('who 可以为空（写不出具体主体时宁可空着）；kind 认不出时落 other 而不是 risk', () => {
    const { summary } = buildQuotedSummaryWithTally(
      summaryWith({
        impacts: [
          { quote: QUOTE_A, who: '', text: '可能有什么', kind: 'risk' },
          { quote: QUOTE_B, who: '运营人', text: '可能有什么', kind: '莫名其妙的值' },
        ],
      }),
      undefined,
      [DRAFT],
    );
    assert.equal(summary.impacts.length, 2);
    assert.equal(summary.impacts[0].who, '');
    assert.equal(summary.impacts[1].kind, 'other', '给判读贴错的类型标签比老实说"其他"更坏');
    assert.equal(IMPACT_KIND_LABELS.other, '其他可能的影响');
  });

  it('带省略号的判读引用也能挂上出处（与上面那条容忍规则同源）', () => {
    const { summary } = buildQuotedSummaryWithTally(
      summaryWith({
        impacts: [{ quote: `${QUOTE_B}……${QUOTE_A}`, who: '', text: '可能有什么', kind: 'risk' }],
      }),
      undefined,
      [DRAFT],
    );
    assert.equal(summary.impacts.length, 1);
    assert.equal(summary.impacts[0].quote, `${QUOTE_B}……${QUOTE_A}`, '落库的是模型给的原样，缺口照留');
  });
});

describe('issue #86：归一化阶段的上限与空值（影响判读）', () => {
  it('超过 12 条 ⇒ 超上限计数 = 多出来的条数', () => {
    const tally = { emptyOrInvalid: 0, overLimit: 0 };
    const impacts = Array.from({ length: 15 }, (_, index) => ({
      quote: `${QUOTE_A}${index}`,
      text: '推断',
      kind: 'risk',
    }));
    const summary = normalizeModelSummary(
      summaryWith({ what: '这是什么', howToComment: '如何提意见', impacts }),
      tally,
    );
    assert.equal(summary.impacts.length, 12);
    assert.equal(tally.overLimit, 3);
    assert.equal(tally.emptyOrInvalid, 0);
  });

  it('空条目 / 类型不对 ⇒ 计入空值那一类', () => {
    const tally = { emptyOrInvalid: 0, overLimit: 0 };
    const summary = normalizeModelSummary(
      summaryWith({
        what: '这是什么',
        howToComment: '如何提意见',
        impacts: [null, '不是对象', { quote: '', text: '推断', kind: 'risk' }, { quote: QUOTE_A, text: '  ', kind: 'risk' }],
      }),
      tally,
    );
    assert.equal(summary.impacts, undefined, '一条都不合格时字段整个不出现（不是空数组）');
    assert.equal(tally.emptyOrInvalid, 4);
  });
});

describe('issue #86：落库形状与旧行兼容', () => {
  it('build → parse 等价（含影响判读）', () => {
    const built = buildQuotedSummary(
      summaryWith({ impacts: [{ quote: QUOTE_A, who: '运营人', text: '可能有什么', kind: 'risk' }] }),
      undefined,
      [DRAFT],
    );
    const parsed = parseQuotedSummary(JSON.parse(JSON.stringify(built)));
    assert.deepEqual(parsed, built);
  });

  it('**旧行没有 impacts 键 ⇒ 空数组，不算形状异常**（存量 84 条全都没有它）', () => {
    const legacy = JSON.parse(
      JSON.stringify(
        buildQuotedSummary(summaryWith({ keyPoints: ['要点'] }), { keyPoints: [QUOTE_A] }, [DRAFT]),
      ),
    );
    delete legacy.impacts;
    const parsed = parseQuotedSummary(legacy);
    assert.ok(parsed, '缺这个键绝不能让存量条目掉回「待人工复核」占位');
    assert.deepEqual(parsed.impacts, []);
    assert.equal(parsed.keyPoints.length, 1);
  });

  it('落库的判读条目脏了也只丢那一条，不打断整页', () => {
    const built = buildQuotedSummary(
      summaryWith({
        impacts: [
          { quote: QUOTE_A, who: '', text: '好的一条', kind: 'risk' },
          { quote: QUOTE_B, who: '', text: '另一条', kind: 'loophole' },
        ],
      }),
      undefined,
      [DRAFT],
    );
    const raw = JSON.parse(JSON.stringify(built));
    raw.impacts.push({ text: '缺引用' }, '不是对象', { quote: '有引用没正文' });
    const parsed = parseQuotedSummary(raw);
    assert.equal(parsed.impacts.length, 2);
  });
});

/**
 * 判据抽在 `lib/impact-display.ts` 而不是写在 `.tsx` 里，为的就是这一组能跑起来 ——
 * 页面组件进不了本仓库的单测，而**钉不住的判据等于没有判据**（自证框架撤 `.tsx` 撤不出红）。
 */
describe('issue #86：「可能的争议点」给谁看', () => {
  const point = {
    quote: '收费公路在收费偿债期间的管理养护费用，在车辆通行费中列支。',
    who: '',
    text: '推断',
    kind: 'risk',
    source: 'aaa.docx',
    sourceUrl: null,
  };

  it('公众广域 + 有判读 ⇒ 渲染', () => {
    assert.equal(shouldRenderImpacts({ audience: 'public', impacts: [point] }), true);
  });

  it('行业专业条目不渲染（用户拍板先只上公众广域）', () => {
    assert.equal(shouldRenderImpacts({ audience: 'sector', impacts: [point] }), false);
  });

  it('未判定也不渲染（判不出来就不给它加码）', () => {
    assert.equal(shouldRenderImpacts({ audience: 'unknown', impacts: [point] }), false);
    assert.equal(shouldRenderImpacts({ audience: null, impacts: [point] }), false);
  });

  it('一条判读都没有时不渲染（空壳比没有更坏）', () => {
    assert.equal(shouldRenderImpacts({ audience: 'public', impacts: [] }), false);
  });
});

/**
 * 提示词本身（issue #86 第十四节）。
 *
 * 为什么要有这一组：`LLM_PROVIDER=stub` 的测试路径**根本不经过提示词** ——
 * 于是"把规则 7 的某一句话删掉"不会有任何门变红，而提示词是这一段产品唯一的判据所在。
 * 断言刻意打在**每条规则的实质要求**上（不是"这段文字还在"）：措辞可以改，
 * 要求不许悄悄消失。删掉任何一条，对应的用例当场变红。
 */
describe('issue #86：规则 7 / 8 的实质要求（提示词是唯一判据，必须钉得住）', () => {
  // SYSTEM_PROMPT 导出的是已经 join 好的整段文本（不是数组）
  const prompt = SYSTEM_PROMPT;

  it('判读的引用必须是**依据**，不是"文中出现过的一句话"（2026-09-27 实测的套话问题）', () => {
    assert.match(prompt, /quote 必须是这条结论的依据/);
    // 判据写成一句可执行的检验：换掉引用后结论是否照样成立
    assert.match(prompt, /把 quote 换成同一份文件里任意另一句/);
    assert.match(prompt, /宁可整条不要/);
  });

  it('两个方向都要找：新增义务/成本/门槛，以及授权过宽、条件模糊、没有救济或过渡', () => {
    assert.match(prompt, /两个方向都要看/);
    assert.match(prompt, /授权过宽、条件模糊、没有救济或没有过渡安排/);
    assert.match(prompt, /不要为了凑其中一个 kind 而编/);
  });

  it('「看不出影响就输出空数组」仍然在（宁缺勿滥的那条不许被新要求挤掉）', () => {
    assert.match(prompt, /看不出影响就输出空数组/);
    assert.match(prompt, /宁可空着/);
  });

  it('禁止定性/指控的口径仍然在（政务 + AI 的敏感面）', () => {
    assert.match(prompt, /不做定性、不指控、不预测结果/);
    assert.match(prompt, /不写「违法」「违宪」/);
  });

  it('影响的「谁」不许写泛称（原文只写社会公众时留空）', () => {
    assert.match(prompt, /不要写「社会公众」「人民群众」/);
  });

  it('改动表（规则 8）的逐字要求与"看不到的部分不要列"仍然在', () => {
    assert.match(prompt, /changes 回答"这一稿把哪几条改成了什么"/);
    assert.match(prompt, /只列你真在文本里看到的改动/);
    assert.match(prompt, /不要写「等」「主要修改内容如下」来掩盖缺口/);
  });
});
