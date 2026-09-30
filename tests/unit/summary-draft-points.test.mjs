import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildQuotedSummary,
  findDraftSourceForQuote,
  normalizeQuoteMarks,
  parseQuotedSummary,
} from '../../src/lib/summary-content.ts';
import { draftBlock, explanationBlock, userPrompt } from '../../src/lib/adapters/openai-compatible-llm.ts';

/**
 * 单元：条文要点的出处核对（issue #57 第 5 / 6 步）。
 *
 * 这一整段的风险只有一个名字：**模型把公告壳里没有的东西说成草案条文**（issue #56 就是
 * 因此删掉了「关键条款」）。现在的防线不是提示词措辞 —— 模型不遵守时页面上看不出来 ——
 * 而是落库前的**程序反查**：一条要点的引用不能在真正喂给模型的条文里逐字找到，这条要点
 * 就不落库。于是「页面上出现了条文要点」的必要条件变成「附件正文确实进了提示词」，
 * 与档位名叫什么、模型听不听话都无关。
 */

const DRAFT = [
  {
    name: '机场垃圾管理办法（征求意见稿）.pdf',
    url: 'https://attachments.test/draft.pdf',
    text: '第一条 为规范机场运营人固体废物处理，制定本办法。\n第二条 中华人民共和国境内的运输机场运营人应当建立固体废物台账。',
  },
  {
    name: '起草说明.docx',
    url: 'https://attachments.test/notes.docx',
    text: '本办法共六章，其中第三章为标准制定的授权条款。',
  },
];

const BASE_SUMMARY = {
  what: '就机场垃圾管理办法征求意见',
  who: '',
  whoCanSubmit: '',
  afterDeadline: '',
  deadline: null,
  howToComment: '邮件反馈',
  channels: [],
};

/** 组装一份「模型输出」：要点 + 与之下标对齐的引用。 */
function modelOutput(points, quotes) {
  return { ...BASE_SUMMARY, keyPoints: points, quotes: { keyPoints: quotes } };
}

describe('findDraftSourceForQuote：引用必须逐字落在喂给模型的条文里', () => {
  it('命中第二份附件就标第二份 —— 多附件时不混标', () => {
    const hit = findDraftSourceForQuote('其中第三章为标准制定的授权条款。', DRAFT);
    assert.equal(hit?.name, '起草说明.docx');
  });

  it('跨换行的引用算命中（PDF 抽取带换行，模型常压成一行）', () => {
    const hit = findDraftSourceForQuote('第一条 为规范机场运营人固体废物处理，制定本办法。', DRAFT);
    assert.equal(hit?.name, '机场垃圾管理办法（征求意见稿）.pdf');
    const wrapped = findDraftSourceForQuote('第一条为规范机场运营人固体废物处理，制定本办法。', DRAFT);
    assert.equal(wrapped?.name, '机场垃圾管理办法（征求意见稿）.pdf', '去空白后应视为同一段');
  });

  it('改写了原文就不算命中（多加一个字都不行）', () => {
    assert.equal(findDraftSourceForQuote('第一条 为规范机场运营人垃圾处理，制定本办法。', DRAFT), null);
  });

  it('短于阈值的"引用"不构成出处：像「第三条」这种片段在哪份公文里都能蒙中', () => {
    assert.equal(findDraftSourceForQuote('第三条', DRAFT), null);
    assert.equal(findDraftSourceForQuote(null, DRAFT), null);
    assert.equal(findDraftSourceForQuote('中华人民共和国境内的运输机场运营人', undefined), null);
  });
});

describe('buildQuotedSummary：核对不上出处的条文要点不落库', () => {
  it('有条文且引用命中 ⇒ 要点带附件名与附件地址', () => {
    const built = buildQuotedSummary(
      modelOutput(
        ['运营人须建立固体废物台账', '第三章授权制定标准'],
        ['中华人民共和国境内的运输机场运营人应当建立固体废物台账。', '本办法共六章，其中第三章为标准制定的授权条款。'],
      ),
      { keyPoints: [
        '中华人民共和国境内的运输机场运营人应当建立固体废物台账。',
        '本办法共六章，其中第三章为标准制定的授权条款。',
      ] },
      DRAFT,
    );
    assert.equal(built.keyPoints.length, 2);
    assert.equal(built.keyPoints[0].source, '机场垃圾管理办法（征求意见稿）.pdf');
    assert.equal(built.keyPoints[0].sourceUrl, 'https://attachments.test/draft.pdf');
    assert.equal(built.keyPoints[1].source, '起草说明.docx');
  });

  it('没有条文输入 ⇒ 模型即使编出要点也全被丢弃（这是影子档与人工补录的兜底）', () => {
    const built = buildQuotedSummary(
      modelOutput(['凭空的一条"条文"'], ['为规范机场运营人固体废物处理，制定本办法。']),
      { keyPoints: ['为规范机场运营人固体废物处理，制定本办法。'] },
      [],
    );
    assert.deepEqual(built.keyPoints, [], '没有喂条文 ⇒ 页面不可能出现条文要点');
    const alsoNull = buildQuotedSummary(
      modelOutput(['凭空的一条"条文"'], ['为规范机场运营人固体废物处理，制定本办法。']),
      { keyPoints: ['为规范机场运营人固体废物处理，制定本办法。'] },
    );
    assert.deepEqual(alsoNull.keyPoints, [], '第三参未传时同样丢弃');
  });

  it('逐条取舍：某条引用被改写，只丢那一条，其余保留', () => {
    const built = buildQuotedSummary(
      modelOutput(
        ['能核对上的一条', '被改写的一条'],
        ['为规范机场运营人固体废物处理，制定本办法。', '这一句原文里根本没有这么长的表述内容啊'],
      ),
      { keyPoints: [
        '为规范机场运营人固体废物处理，制定本办法。',
        '这一句原文里根本没有这么长的表述内容啊',
      ] },
      DRAFT,
    );
    assert.equal(built.keyPoints.length, 1);
    assert.equal(built.keyPoints[0].text, '能核对上的一条');
  });

  it('下标对齐：中间那条漏了引用，不会让后面的要点挂上前面的出处', () => {
    const built = buildQuotedSummary(
      modelOutput(['要点一', '要点二'], ['第一条 为规范机场运营人固体废物处理，制定本办法。', '']),
      { keyPoints: ['第一条 为规范机场运营人固体废物处理，制定本办法。', ''] },
      DRAFT,
    );
    assert.equal(built.keyPoints.length, 1);
    assert.equal(built.keyPoints[0].text, '要点一', '要点二 的引用是空串，必须整体丢弃');
  });

  it('落库再回读：出处跟着走；旧格式（无 source 字段）回读成 null 而不是假装标过', () => {
    const built = buildQuotedSummary(
      modelOutput(['运营人须建立台账'], ['中华人民共和国境内的运输机场运营人应当建立固体废物台账。']),
      { keyPoints: ['中华人民共和国境内的运输机场运营人应当建立固体废物台账。'] },
      DRAFT,
    );
    const round = parseQuotedSummary(JSON.parse(JSON.stringify(built)));
    assert.equal(round?.keyPoints[0].source, '机场垃圾管理办法（征求意见稿）.pdf');

    const legacy = parseQuotedSummary({
      what: { text: 'w', quote: null },
      deadline: { text: null, quote: null },
      howToComment: { text: 'h', quote: null },
      keyPoints: [{ text: '旧格式要点', quote: '某段引用', source: undefined }],
    });
    assert.equal(legacy?.keyPoints[0].source, null, '旧摘要没有出处字段，就该是 null');
    assert.equal(legacy?.keyPoints[0].sourceUrl, null);
  });
});

describe('draftBlock：条文段落出现与否就是提示词的全部依据', () => {
  it('没有条文 ⇒ 连「附件条文」四个字都不出现（占位文字会让"没给"和"给了空的"看起来一样）', () => {
    assert.equal(draftBlock(undefined), '');
    assert.equal(draftBlock([]), '');
    assert.equal(draftBlock([{ name: '空表.docx', url: 'https://x.test/e.docx', text: '   ' }]), '');
  });

  it('有条文 ⇒ 带份数与文件名的段落，逐份分节', () => {
    const block = draftBlock(DRAFT);
    assert.match(block, /附件条文/);
    assert.match(block, /共 2 份/);
    assert.match(block, /【附件 1：机场垃圾管理办法（征求意见稿）\.pdf】/);
    assert.match(block, /【附件 2：起草说明\.docx】/);
    assert.ok(block.indexOf('起草说明.docx') < block.indexOf('本办法共六章'), '文件名标签应在正文之前');
  });
});

describe('issue #86 第 3 刀：两段正文的上限随档位（最后一道防线不许切掉预算允许的内容）', () => {
  /** 20,000 字符的说明：**每一行都带序号**，这样"尾行在不在"才是一个有区分度的判据。 */
  const longExplanation = (lines) =>
    Array.from(
      { length: lines },
      (_, i) => `第${i + 1}项 为了规范某某活动第${i + 1}类情形，制定本办法。\n`,
    ).join('');
  const LONG_EXPLANATION = longExplanation(1_000);
  const EXPLANATION_TAIL = `第1000项 为了规范某某活动第1000类情形，制定本办法。`;
  const EXPLANATION = [
    { name: '某某办法（征求意见稿）编制说明.docx', url: 'https://attachments.test/e.docx', text: LONG_EXPLANATION, role: 'explanation' },
  ];
  const DRAFT_SOURCE = [
    { name: '某某办法（征求意见稿）.docx', url: 'https://attachments.test/d.docx', text: longExplanation(900), role: 'draft' },
  ];
  const input = (extra) => ({
    title: '关于《某某办法（征求意见稿）》公开征求意见的公告',
    bodyText: '现就该办法征求意见。',
    url: 'https://source.test/n.html',
    ...extra,
  });

  it('上限明着给的时候按它切（判据是 `slice(0, maxChars)`，没有第二条路）', () => {
    assert.ok(LONG_EXPLANATION.length > 20_000);
    assert.ok(draftBlock(DRAFT_SOURCE, 1_000).length <= 1_000 + '附件条文'.length + 200);
    assert.ok(explanationBlock(EXPLANATION, 1_000).length <= 1_000 + '编制说明'.length + 200);
  });

  it('标准档（缺省）与不写档位完全一样 —— 行业专业那一档的行为一个字都没动', () => {
    const withoutTier = userPrompt(input({ draftSources: [...DRAFT_SOURCE, ...EXPLANATION] }));
    const explicitStandard = userPrompt(
      input({ draftSources: [...DRAFT_SOURCE, ...EXPLANATION], tier: 'standard' }),
    );
    assert.equal(withoutTier, explicitStandard);
  });

  it('重档放得下那份 20,000 字符的说明（标准档会把它切掉一半）', () => {
    const sources = [...DRAFT_SOURCE, ...EXPLANATION];
    const standard = userPrompt(input({ draftSources: sources, tier: 'standard' }));
    const deep = userPrompt(input({ draftSources: sources, tier: 'deep' }));
    assert.ok(deep.length > standard.length, '重档必须真的喂得更多，否则这个档就是空档');
    assert.ok(standard.includes('第1项'), '两种档位都该从头喂');
    assert.equal(deep.includes(EXPLANATION_TAIL), true, '重档要把整份说明喂进去');
    assert.equal(
      standard.includes(EXPLANATION_TAIL),
      false,
      '标准档切掉尾部正是它今天的行为（本刀不动它）',
    );
  });
});

/**
 * 2026-09-30 生产实测：**引号字形**是一个"按字形整批丢行"的开关。
 *
 * 逐字反查要求模型的 `quote` 在本轮真喂进去的正文里逐字出现，找不到就整行丢弃。附件原文里
 * 是中文引号 `“ ”`，而模型这一遍吐的是 ASCII 直引号 `"` —— 词句逐字一致、只差字形，那一遍
 * **9 行全部**被判"对不上"（改动点 0/9，页面上「改了哪几处」只剩事实行）；换一遍模型用中文
 * 引号，同一份输入就保住 5–8 行。夹具照生产上丢得最狠的那一条搭（《公路法（修正草案）》的
 * 第三十六条），下面这一组只准放松**字形**这一层 —— 改实词 / 少一段 / 顺序颠倒 / 短于门槛，
 * 四条反向用例一条都不许变绿（红线见 docs/pending-issues/67-summaries-redraft.md 第八节）。
 */
const ROAD_TEXT =
  '一、将第三十六条修改为：“国家采用依法征税的办法筹集公路管理养护资金，本法对收费公路另有规定的除外。”\n' +
  '二、将第五十九条修改为：“符合下列条件的公路，可以收费。”';
const ROAD_CLAUSE_36 = '国家采用依法征税的办法筹集公路管理养护资金，本法对收费公路另有规定的除外。';
const ROAD_DRAFT = [
  {
    name: '公路法（修正草案征求意见稿）.docx',
    url: 'https://attachments.test/road.docx',
    text: ROAD_TEXT,
  },
];
/** 同一句话的四种字形写法：中文引号（原文）/ ASCII 直引号（丢行那一遍）/ 角括号 / 一条里混用。 */
const QUOTE_36_CJK = `将第三十六条修改为：“${ROAD_CLAUSE_36}”`;
const QUOTE_36_ASCII = QUOTE_36_CJK.replaceAll('“', '"').replaceAll('”', '"');
const QUOTE_36_CORNER = QUOTE_36_CJK.replaceAll('“', '「').replaceAll('”', '」');
const QUOTE_36_MIXED = QUOTE_36_CJK.replace('”', '"');

/** 一份只带改动点的"模型输出"（落库那一路的形状）。 */
function changeOutput(quote, text = '改由国家依法征税筹集公路养护资金') {
  return {
    ...BASE_SUMMARY,
    changes: [{ clause: '第三十六条', kind: 'modify', text, quote }],
  };
}

describe('2026-09-30：引号字形归一（只准放松字形，其余判据一个字都不许松）', () => {
  it('归一化只动引号字符：别的字符一个都不动，而且长度不变', () => {
    const raw = '“甲”‘乙’「丙」『丁』＂戊＂＇己＇，。《》　（庚）';
    assert.equal(normalizeQuoteMarks(raw), '"甲"\'乙\'"丙""丁""戊"\'己\'，。《》　（庚）');
    assert.equal(normalizeQuoteMarks(raw).length, raw.length, '长度必须一样：归句那边靠它回推原文下标');
    assert.equal(normalizeQuoteMarks('已经归一过的 "甲"'), '已经归一过的 "甲"', '再调用一次不变');
    assert.notEqual(
      normalizeQuoteMarks("'甲'"),
      normalizeQuoteMarks('“甲”'),
      '单引号族与双引号族不互相等价 —— 混着归一才会造出假的命中',
    );
  });

  it('① 只差引号字形 ⇒ 保留（四种写法都命中同一份附件）', () => {
    for (const quote of [QUOTE_36_CJK, QUOTE_36_ASCII, QUOTE_36_CORNER, QUOTE_36_MIXED]) {
      assert.equal(
        findDraftSourceForQuote(quote, ROAD_DRAFT)?.name,
        '公路法（修正草案征求意见稿）.docx',
        `${quote} 应当命中`,
      );
    }
    // 走一遍落库形状：改动点与条文要点都过 `findDraftSourceForQuote` 这一道门，
    // 所以两处都要看得见这件事（生产上丢的就是改动点这一行）。
    const changes = buildQuotedSummary(changeOutput(QUOTE_36_ASCII), undefined, ROAD_DRAFT);
    assert.equal(changes.changes.length, 1);
    assert.equal(changes.changes[0].source, '公路法（修正草案征求意见稿）.docx');
    assert.equal(
      changes.changes[0].quote,
      QUOTE_36_ASCII.replace(/"$/, ''),
      '落库的是模型给的原话：字形一个字都没被改写（末尾那层包裹引号由 cleanQuote 照旧去掉）',
    );
    const points = buildQuotedSummary(
      modelOutput(['须依法征税筹集养护资金'], [QUOTE_36_ASCII]),
      { keyPoints: [QUOTE_36_ASCII] },
      ROAD_DRAFT,
    );
    assert.equal(points.keyPoints.length, 1, '条文要点同样不该因为字形被丢');
  });

  it('② 引用里改了一个实词（依法征税 → 依法收税）⇒ 照样丢', () => {
    const altered = QUOTE_36_ASCII.replace('依法征税', '依法收税');
    assert.notEqual(altered, QUOTE_36_ASCII);
    assert.equal(findDraftSourceForQuote(altered, ROAD_DRAFT), null);
    const built = buildQuotedSummary(changeOutput(altered), undefined, ROAD_DRAFT);
    assert.deepEqual(built.changes, [], '反查不过 ⇒ 整行不落库（这一条是红线本身）');
  });

  it('③ 引用中间少了一段、又不写省略号 ⇒ 照样丢（省略号才允许有缺口）', () => {
    const shortened = `将第三十六条修改为："国家采用依法征税的办法筹集公路管理养护资金，公路另有规定的除外。"`;
    assert.equal(findDraftSourceForQuote(shortened, ROAD_DRAFT), null);
    const built = buildQuotedSummary(changeOutput(shortened), undefined, ROAD_DRAFT);
    assert.deepEqual(built.changes, []);
  });

  it('③′ 省略号切出来的那一段原文里根本没有 ⇒ 照样丢（有缺口不等于可以编一段）', () => {
    const fabricated = `${QUOTE_36_ASCII}…"这一段原文里根本不存在。"`;
    assert.equal(findDraftSourceForQuote(fabricated, ROAD_DRAFT), null);
  });

  it('④ 两段都逐字、但顺序颠倒 ⇒ 照样丢（省略号只允许"按原顺序跳读"）', () => {
    const reversed = `“符合下列条件的公路，可以收费。”…“${ROAD_CLAUSE_36}”`;
    assert.equal(findDraftSourceForQuote(reversed, ROAD_DRAFT), null);
  });

  it('⑤ 某一段短于 8 字 ⇒ 照样丢，哪怕那一小段真的在原文里', () => {
    assert.ok(ROAD_TEXT.includes('第三十六条'), '这一小段确实逐字在原文里 —— 丢它靠的是门槛，不是"对不上"');
    assert.notEqual(findDraftSourceForQuote(ROAD_CLAUSE_36, ROAD_DRAFT), null, '长的那一段单独查是命中的');
    const shortSegment = `"第三十六条"…"${ROAD_CLAUSE_36}"`;
    assert.equal(findDraftSourceForQuote(shortSegment, ROAD_DRAFT), null);
  });
});
