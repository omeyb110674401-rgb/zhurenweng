import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { impactsToRender } from '../../src/lib/impact-display.ts';
import { impactReviewRecordsFrom } from '../../src/lib/impact-review.ts';

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
 * issue #47：判读的渲染门 —— **选择器**（读者到底看到哪几条、看到的是哪一句）。
 *
 * 这一组是本功能**唯一的测试缝**（`docs/prd/v2.md`「Testing Decisions」）：审读的判定与存储
 * 都在它上游，而它们的全部读者可见后果最终必须表现为**这个函数的输出**。所以这里断言的
 * 全是外部行为 —— "读者会不会看到这一段、看到的是哪一句"，不是"函数被调了几次"。
 *
 * 判据仍然抽在 `lib/impact-display.ts`（页面 `.tsx` 进不了单测，撤 `.tsx` 撤不出红）。
 * 审读记录的**形状与接受条件**在 `tests/unit/impact-review.test.mjs`；两组分开的理由：
 * 那边判的是"模型说了什么我们才认"，这边判的是"认下来之后读者看到什么"。
 */
describe('issue #47：「可能的争议点」渲染门（选择器）', () => {
  const IMPACT = {
    quote: '收费公路在收费偿债期间的管理养护费用，在车辆通行费中列支。',
    who: '高速公路通行车主',
    point: '通行费用支出',
    text: '期限届满后可能继续收费，通行者的支出预期被改变。',
    kind: 'burden',
    source: '中华人民共和国公路法（修正草案征求意见稿）.docx',
    sourceUrl: null,
  };
  const OTHER = {
    quote: '收费公路的收费期限，由省、自治区、直辖市人民政府规定。',
    who: '高速公路通行车主',
    point: '收费期限',
    text: '期限的确定权在省级政府，通行者难以预期何时停止收费。',
    kind: 'risk',
    source: '中华人民共和国公路法（修正草案征求意见稿）.docx',
    sourceUrl: null,
  };
  // 审读后文本刻意**不含**原推断正文的任何一截：下面那条断言要能证明"原文一个字都不出现"
  const REVISED_TEXT = '审读后：收费期限的延续缺乏明确表述，车主难以预期何时停止付费。';

  /** 一条审读记录：走**写侧**造出来（指纹的口径只有一处，测试里不手抄）。 */
  function recordsFor(status, impact = IMPACT) {
    return impactReviewRecordsFrom({
      impacts: [impact],
      verdicts: [
        {
          quote: impact.quote,
          text: impact.text,
          status,
          revisedText: status === 'revised' ? REVISED_TEXT : null,
        },
      ],
      model: 'stub',
      reviewedAt: '2026-10-04T12:00:00.000Z',
    });
  }

  it('**没有记录 ⇒ 一条都不渲染**（fail-closed：判不出来就不给它加码）', () => {
    for (const reviews of [undefined, null, []]) {
      assert.equal(
        impactsToRender({ impacts: [IMPACT], reviews }),
        null,
        '没有有效审读记录 ⇒ 这一条不渲染（#52 的目标形态：门只认记录）',
      );
    }
  });

  it('受众面**不再是判据**：行业专业 / 未判定 + 有效记录 ⇒ 照样渲染', () => {
    // #52 之前这三个受众面一律不渲染（那时候门里还有受众面）。现在门只认审读记录，
    // 而"内容可不可以见读者"这件事由审读接手 —— 受众面继续管与风险无关的事（「影响谁」）。
    for (const status of ['passed', 'revised']) {
      const rendered = impactsToRender({ impacts: [IMPACT], reviews: recordsFor(status) });
      assert.notEqual(rendered, null, `有有效记录（${status}）就该渲染，与受众面无关`);
    }
  });

  it('有有效记录：通过 ⇒ 渲染原文', () => {
    const rendered = impactsToRender({ impacts: [IMPACT], reviews: recordsFor('passed') });
    assert.deepEqual(rendered, [IMPACT]);
  });

  it('有有效记录：已改 ⇒ 渲染审读后文本，原文不出现', () => {
    const rendered = impactsToRender({ impacts: [IMPACT], reviews: recordsFor('revised') });
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0].text, REVISED_TEXT);
    assert.ok(!JSON.stringify(rendered).includes(IMPACT.text), '原文一个字都不该留在渲染结果里');
  });

  it('有有效记录：剔除 ⇒ 该条不出现，同一段其余照常', () => {
    const rendered = impactsToRender({
      impacts: [IMPACT, OTHER],
      reviews: [...recordsFor('rejected'), ...recordsFor('passed', OTHER)],
    });
    assert.deepEqual(rendered, [OTHER], '逐条剔除 —— 同一段里其余照常，不是整块消失');
  });

  it('全部剔除 ⇒ null（整段不渲染，连标题都不出现）', () => {
    const reviews = [...recordsFor('rejected', IMPACT), ...recordsFor('rejected', OTHER)];
    assert.equal(impactsToRender({ impacts: [IMPACT, OTHER], reviews }), null);
    assert.equal(impactsToRender({ impacts: [IMPACT], reviews: recordsFor('rejected') }), null);
  });

  it('指纹对不上（生成侧重跑）⇒ 视为没有记录 ⇒ **不渲染**（不沿用旧结论、也不退回原文）', () => {
    // 上一轮的记录：审的是**改动前**的推断正文，而且它是一条「通过」——
    // 所以只要配对放宽一点（例如只看引用不看正文），它就会把**旧结论**照旧用上：
    // 那条记录会渲染出改动前的原文，而读者以为自己看到的是新文本的合规结论。
    const stale = recordsFor('passed');
    const rerun = { ...IMPACT, text: '重跑之后模型换了一种说法。' };
    assert.equal(
      impactsToRender({ impacts: [rerun], reviews: stale }),
      null,
      '没被审读过的文本不许配着别人的结论，也不许因为没记录而被放行',
    );
  });

  it('指纹全等（内容一字未变）⇒ 旧记录幂等有效（同一份内容、同一份结论）', () => {
    const records = recordsFor('revised');
    const rerun = { ...IMPACT, quote: `${IMPACT.quote}\n` };
    const rendered = impactsToRender({ impacts: [rerun], reviews: records });
    assert.equal(rendered[0].text, REVISED_TEXT, '内容没变 ⇒ 结论照旧成立');
  });

  it('一条判读都没有 ⇒ null（空壳比没有更坏，连标题都不出现）', () => {
    assert.equal(impactsToRender({ impacts: [] }), null);
  });

  it('审读只动 text：who / point / kind / quote / 出处原样带出去', () => {
    const rendered = impactsToRender({ impacts: [IMPACT], reviews: recordsFor('revised') });
    const { text, ...rest } = rendered[0];
    const { text: originalText, ...expected } = IMPACT;
    assert.deepEqual(rest, expected);
    assert.equal(text, REVISED_TEXT);
  });

  it('一条有记录、一条没有 ⇒ 只渲染有记录的那条（缺的那条不把整段拖掉）', () => {
    const rendered = impactsToRender({ impacts: [IMPACT, OTHER], reviews: recordsFor('passed') });
    assert.deepEqual(rendered, [IMPACT], '缺记录的逐条不渲染 —— 与"整段不渲染"是两回事');
  });
});

/**
 * 接线（源码）：判据对了、页面没接上，是这一类改动最常见的断线 —— 而它在 e2e 里**看不见**
 * （详情页 `.tsx` 跑的是 `.next` 构建产物，撤 SSR 侧源码不会红，见 `check-test-pins.mjs` 规则 1）。
 *
 * 这里钉三件事，正好对应 `docs/prd/v2.md`「要被断言的外部行为」第 11 条：
 * ① 页面经由**同一道门**；② 具体读的**是门的返回值**（不是又去读 `summary.impacts`）；
 * ③ 审读记录真的被喂进去了（没喂的话，审读层在页面上等于不存在）。
 */
describe('issue #47：接线（源码）', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const view = readFileSync(path.join(repoRoot, 'src/app/_lib/summary-view.tsx'), 'utf8');
  const page = readFileSync(path.join(repoRoot, 'src/app/notices/[id]/page.tsx'), 'utf8');

  it('详情页经同一道门取判读，且不再留第二份判据', () => {
    assert.match(view, /const impacts = impactsToRender\(\{/, '渲染必须经由门（选择器）');
    assert.doesNotMatch(view, /shouldRenderImpacts/, '旧谓词已删除，页面不许留着它当第二份判据');
    assert.doesNotMatch(
      view,
      /const hasImpacts\s*=\s*summary\.impacts\.length/,
      '底部「摘要依据」那句必须读门的结论，不许自己判一遍（否则它会指着一块不渲染的栏目说话）',
    );
  });

  it('详情页把审读记录喂进摘要卡（没喂 = 审读层在页面上不存在）', () => {
    assert.match(
      page,
      /impactReviews=\{parseImpactReviews\(summaryInfo\.impactReviewJson\)\}/,
      '审读记录必须从库列读出来、解析后传进摘要卡',
    );
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

  it('复述条文不算影响：反向例子与"换个写法还成立吗"这条反问都在（2026-09-28 生产实测的第一号毛病）', () => {
    // 三条真实条目、9 条判读里有 2–3 条是"复述罚则"：引用一句罚则/禁令，text 写
    // 「可能面临处罚 / 可能被查处 / 可能存在执行漏洞」。这一条钉住的是**判据本身**
    // （一句可执行的反问 + 三种废条目的形状），不是某句措辞。
    assert.match(prompt, /复述条文不是影响/);
    assert.match(prompt, /把这句话引用的那条规定改个写法/, '反问句是这条判据的可执行形式');
    assert.match(prompt, /成立就不是影响/);
    assert.match(prompt, /复述罚则/);
    assert.match(prompt, /复述禁令/);
    assert.match(prompt, /只有结论没有机制/);
    // 光有"不要什么"不够：必须同时给出**要什么**（谁 → 哪一处 → 可能发生什么）
    assert.match(prompt, /所以 text 里要看得见\*\*机制\*\*/);
    assert.match(prompt, /loophole 尤其要点名\*\*那个缺口在哪一句的哪个字眼上\*\*/);
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

/**
 * issue #88 第二刀：「影响点」三件里的 `point`（受影响的**方面**）落库与读侧容错。
 *
 * `point` 与 `who` 是**同一类字段**（都是"缺了就不渲染那半句"的可选半边），所以这一组钉的
 * 全是"缺了不许出事"：
 * 1. **旧行没有 `point` 键 ⇒ 空串、条目仍在、其余字段一个字不变**。生产库里 39 条判读
 *    全都没有这个键（88 号文档 7.2 实测），而它们是读者今天就会看到的那些条目 ——
 *    解析若把它当必填，那 39 条会从「有判读」变成整块消失，**页面上没有任何痕迹**。
 * 2. **超长值照实保留**：长度约束写在提示词里，落库与读侧都不许按长度砍（88 号文档 7.4）。
 *    在解析层截断等于静默丢真内容，而且"模型守不守 12 字"这件事再也量不出来。
 */
describe('issue #88 第二刀：point（受影响的方面）的落库与旧行容错', () => {
  it('buildImpacts 带出 point（前后空白要 trim）', () => {
    const { summary } = buildQuotedSummaryWithTally(
      summaryWith({
        impacts: [
          { quote: QUOTE_A, who: '平台', point: ' 合规成本 ', text: '可能有什么', kind: 'burden' },
        ],
      }),
      undefined,
      [DRAFT],
    );
    assert.equal(summary.impacts.length, 1);
    assert.equal(summary.impacts[0].point, '合规成本');
    assert.equal(summary.impacts[0].who, '平台', 'who 那半句一个字不动');
  });

  it('模型没写 point ⇒ 空串落库，条目照旧在（它是可缺的那半句）', () => {
    const { summary } = buildQuotedSummaryWithTally(
      summaryWith({
        impacts: [{ quote: QUOTE_A, who: '平台', text: '可能有什么', kind: 'risk' }],
      }),
      undefined,
      [DRAFT],
    );
    assert.equal(summary.impacts.length, 1, '缺 point 不是"缺引用/缺正文"，不该整条丢');
    assert.equal(summary.impacts[0].point, '');
    assert.equal(summary.impacts[0].who, '平台');
  });

  it('**旧行没有 point 键 ⇒ 空串、条目仍在、其余字段一个字不变**（存量 39 条判读全都没有它）', () => {
    const built = buildQuotedSummary(
      summaryWith({
        impacts: [
          { quote: QUOTE_A, who: '运营人', point: '合规成本', text: '可能有什么', kind: 'loophole' },
        ],
      }),
      undefined,
      [DRAFT],
    );
    const before = built.impacts[0];
    assert.equal(before.point, '合规成本', '前提：这一条本来带着 point，否则下面测不出"丢了什么"');

    const legacy = JSON.parse(JSON.stringify(built));
    delete legacy.impacts[0].point;
    const parsed = parseQuotedSummary(legacy);

    assert.equal(parsed.impacts.length, 1, '缺一个可缺的键绝不能让整条判读消失');
    assert.equal(parsed.impacts[0].point, '', '退回空串 —— 页面据此只渲染 who 那半句');
    assert.equal(parsed.impacts[0].quote, before.quote);
    assert.equal(parsed.impacts[0].who, before.who);
    assert.equal(parsed.impacts[0].text, before.text);
    assert.equal(parsed.impacts[0].kind, before.kind);
    assert.equal(parsed.impacts[0].source, before.source);
    assert.equal(parsed.impacts[0].sourceUrl, before.sourceUrl);
  });

  it('超长的 point 照实保留（不截断、不因为超长丢条目 —— 长度约束靠提示词）', () => {
    const tooLong = '这个方面写得很长很长一直写到三十多个字都还没有停下来而且还要继续更长一些';
    assert.ok(tooLong.length > 12, '前提：这个值确实超出了提示词写的 12 字');
    const built = buildQuotedSummary(
      summaryWith({
        impacts: [{ quote: QUOTE_A, who: '平台', point: tooLong, text: '可能有什么', kind: 'risk' }],
      }),
      undefined,
      [DRAFT],
    );
    assert.equal(built.impacts[0].point, tooLong, '落库不许截断');

    const parsed = parseQuotedSummary(JSON.parse(JSON.stringify(built)));
    assert.equal(parsed.impacts.length, 1, '超长不是"形状不对"，不该丢条目');
    assert.equal(parsed.impacts[0].point, tooLong, '读侧照实显示：截断是静默丢真内容');
    assert.equal(parsed.impacts[0].point.length, tooLong.length);
  });
});

/**
 * issue #88 第二刀：提示词里 `who` / `point` 的**新实质约束**（规格 7.3）。
 *
 * 为什么单独一组：`LLM_PROVIDER=stub` 的测试路径不经过提示词，所以"把 `point` 的约束整条删掉"
 * 不会有任何门变红 —— 而这一刀新增的正是"方面"这个字段，它的全部判据就在提示词里。
 *
 * 断言打在**要求那一段的 bullet**上（不是字段示例那一行）：提示词是"一行一条"拼出来的，
 * 字段示例（那一行 JSON）说的是"这个字段放什么"，要求里的 bullet 说的才是
 * "不许怎么写"（罗列主体 / 写成句子 / 把 who 换个说法重写）。两者都会影响模型，
 * 但**只有后者是要求**；按行找 bullet 的写法也让措辞可以改，约束不许悄悄消失。
 */
describe('issue #88 第二刀：who / point 的实质约束（提示词是唯一判据）', () => {
  const prompt = SYSTEM_PROMPT;

  /** 在**要求**那一段里按行找 bullet（`   - …`），字段示例那一行（JSON）不算。 */
  function requirementLine(...needles) {
    return prompt
      .split('\n')
      .find((line) => line.trimStart().startsWith('- ') && needles.every((n) => line.includes(n)));
  }

  it('who 的要求里写着 20 字上限、单一主体类别、最多一个顿号', () => {
    const rule = requirementLine('who', '20 字以内');
    assert.ok(rule, 'who 的字数上限必须写进**要求**（模型看不到的约束等于没有）');
    assert.match(rule, /单一主体类别/, '一句话里塞三四个主体正是用户说的"笼统"');
    assert.match(rule, /最多一个顿号/, '顿号数量是这条约束唯一可执行的判据');
  });

  it('反例（五个主体四个顿号那条长串）逐字在提示词里', () => {
    assert.match(
      prompt,
      /网络服务提供者、网络平台服务提供者、互联网用户公众账号生产运营者、学校、未成年人监护人/,
      '反例必须写成那串真实的主体罗列 —— 抽象地说"不要罗列"拦不住它',
    );
  });

  it('point 的要求里写着 12 字上限、是"方面"而不是第二个 who', () => {
    const rule = requirementLine('point', '12 字以内');
    assert.ok(rule, 'point 的字数上限必须写进**要求**');
    assert.match(rule, /方面|东西/, 'point 回答的是"他的什么被动了"，不是"谁"');
    assert.match(rule, /不是主体/, '写成第二个 who 就退化成了重复');
  });

  it('正例「平台 · 合规成本」在提示词里（把 who 与 point 的分工摆出来）', () => {
    assert.match(prompt, /平台 · 合规成本/);
  });

  it('写不出来就留空、不许为了填满而编（新字段不能破既有口径）', () => {
    assert.match(prompt, /不许为了填满而编/);
  });
});
