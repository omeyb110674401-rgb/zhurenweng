import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildQuotedSummary,
  findDraftSourceForQuote,
  parseQuotedSummary,
} from '../../src/lib/summary-content.ts';
import { draftBlock } from '../../src/lib/adapters/openai-compatible-llm.ts';

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
