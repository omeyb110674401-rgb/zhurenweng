import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  IMPACT_REVIEW_STATUSES,
  IMPACT_REVIEW_STATUS_LABELS,
  findImpactReview,
  impactReviewRecordsFrom,
  parseImpactReviews,
  serializeImpactReviews,
} from '../../src/lib/impact-review.ts';
import { quoteFingerprint } from '../../src/lib/summary-content.ts';

/**
 * 单元：审读记录的形状、读侧容错与「只减不加」的接受条件（issue #47）。
 *
 * 这一组钉的是**存储与端口之间的那道关**，不是渲染（渲染在 `summary-impacts.test.mjs`
 * 的门那一组）。为什么两者必须分开：渲染那一层判的是"读者看到哪一份文本"，
 * 而这一层判的是"模型说了什么我们才认"—— 混在一组里，改其中一处的失败方式看不出是哪一处。
 *
 * 三条贯穿全组的规矩（都对应已拍板的决定）：
 * 1. **指纹由本仓从判读现算**，永不采用模型回显的字符串（决定 19）；
 * 2. **只减不加**：想换 quote、想新增或删除条目 ⇒ 那条结论不被接受（硬约束 8）；
 * 3. **歧义与缺项都不放行**：同一条判读两份结论 ⇒ 整份不采信；端口一句话没说 ⇒
 *    那条**没有记录**（不补"通过"）—— 没被审读过的文本不许因为沉默而被放行。
 *
 * 指纹口径是生成侧反查用的 `quoteFingerprint`（引号字形归一 + 去全部空白）：
 * 这里有一条用例专门钉"一份只差换行的回显照样配对"，因为附件抽取出来的原文本来就带换行。
 */

/** 一条形状完整的判读（字段取自 issue #88 第二刀之后的新形状）。 */
const IMPACT = {
  quote: '收费公路在收费偿债期间的管理养护费用，在车辆通行费中列支。',
  who: '高速公路通行车主',
  point: '通行费用支出',
  text: '期限届满后可能继续收费，通行者的支出预期被改变。',
  kind: 'burden',
  source: '中华人民共和国公路法（修正草案征求意见稿）.docx',
  sourceUrl: null,
};

const SECOND = {
  quote: '收费公路的收费期限，由省、自治区、直辖市人民政府规定。',
  who: '高速公路通行车主',
  point: '收费期限',
  text: '期限的确定权在省级政府，通行者难以预期何时停止收费。',
  kind: 'risk',
  source: '中华人民共和国公路法（修正草案征求意见稿）.docx',
  sourceUrl: null,
};

/** 一条记录（走**写侧**造出来，于是测试里不必手抄指纹 —— 手抄的指纹会跟着口径漂移）。 */
function recordsFor(verdicts, impacts = [IMPACT]) {
  return impactReviewRecordsFrom({
    impacts,
    verdicts,
    model: 'stub',
    reviewedAt: '2026-10-04T12:00:00.000Z',
  });
}

describe('issue #47：审读记录的取值与形状', () => {
  it('三种结论是互斥的白名单，且各有中文展示名（只在诊断与审计面可见）', () => {
    assert.deepEqual([...IMPACT_REVIEW_STATUSES], ['passed', 'revised', 'rejected']);
    assert.equal(IMPACT_REVIEW_STATUS_LABELS.passed, '通过');
    assert.equal(IMPACT_REVIEW_STATUS_LABELS.revised, '已改');
    assert.equal(IMPACT_REVIEW_STATUS_LABELS.rejected, '剔除');
  });

  it('一条记录里没有"理由"字段（说不清凭什么的一律不设）', () => {
    const [record] = recordsFor([{ ...IMPACT, status: 'passed' }]);
    assert.deepEqual(Object.keys(record).sort(), [
      'model',
      'quoteFingerprint',
      'reviewedAt',
      'revisedText',
      'status',
      'textFingerprint',
    ]);
  });
});

describe('issue #47：审读记录的读侧容错（坏数据不许打断整页）', () => {
  it('认不出的形状一律当"没有记录"：null / 非数组 / 不是 JSON 的字符串 / 对象', () => {
    for (const value of [null, undefined, '', '不是 JSON', 42, {}, '{}', [1, 2, 3]]) {
      assert.deepEqual(parseImpactReviews(value), [], `入参 ${JSON.stringify(value)} 应当被吞掉`);
    }
  });

  it('那一条坏、别的照旧：逐项校验，不因为一项脏就丢掉整列', () => {
    const [good] = recordsFor([{ ...IMPACT, status: 'passed' }]);
    const value = [good, null, '不是对象', { status: 'passed' }, { ...good, status: '莫名其妙' }];
    const parsed = parseImpactReviews(value);
    assert.equal(parsed.length, 1, '只有那条完整记录能活下来');
    assert.deepEqual(parsed[0], good);
  });

  it('空指纹不认：那种记录匹配不上任何一条判读，留着只会让"有几条记录"这个数说谎', () => {
    const [good] = recordsFor([{ ...IMPACT, status: 'passed' }]);
    assert.deepEqual(parseImpactReviews([{ ...good, quoteFingerprint: '' }]), []);
    assert.deepEqual(parseImpactReviews([{ ...good, textFingerprint: '' }]), []);
  });

  it('「已改」没有文本 ⇒ 那份记录**不成立**（宁可不认，也不猜它想说什么）', () => {
    const [good] = recordsFor([{ ...IMPACT, status: 'revised', revisedText: '改过的正文' }]);
    assert.equal(parseImpactReviews([good]).length, 1, '前提：这份记录本来是成立的');
    assert.deepEqual(parseImpactReviews([{ ...good, revisedText: null }]), []);
    assert.deepEqual(parseImpactReviews([{ ...good, revisedText: '' }]), []);
    assert.deepEqual(parseImpactReviews([{ ...good, revisedText: '   ' }]), []);
  });

  it('非「已改」的记录一律把审读后文本归一成 null（通过 / 剔除没有"改后的正文"）', () => {
    const [passed] = recordsFor([{ ...IMPACT, status: 'passed', revisedText: '不该被采信的文本' }]);
    assert.equal(passed.revisedText, null);
    const [rejected] = recordsFor([{ ...IMPACT, status: 'rejected', revisedText: '同上' }]);
    assert.equal(rejected.revisedText, null);
  });

  it('审计字段缺失不影响采信（model / reviewedAt 补空串：它们不是判据）', () => {
    const [good] = recordsFor([{ ...IMPACT, status: 'passed' }]);
    const parsed = parseImpactReviews([{ ...good, model: undefined, reviewedAt: 42 }]);
    assert.equal(parsed.length, 1, '"审计字段不全"与"这条该不该渲染"是两件事');
    assert.equal(parsed[0].model, '');
    assert.equal(parsed[0].reviewedAt, '');
    assert.equal(parsed[0].status, 'passed');
  });

  it('列值可以直接给未解析的 JSON 字符串（调用方不必先 safeParseJson）', () => {
    const records = recordsFor([{ ...IMPACT, status: 'rejected' }]);
    const parsed = parseImpactReviews(JSON.stringify(records));
    assert.deepEqual(parsed, records);
  });

  it('写侧：一条记录都没有 ⇒ null（不写空数组 —— `is not null` 是"跑过审读没有"的判据）', () => {
    assert.equal(serializeImpactReviews([]), null);
    const records = recordsFor([{ ...IMPACT, status: 'passed' }]);
    assert.deepEqual(parseImpactReviews(serializeImpactReviews(records)), records);
  });
});

describe('issue #47：审读记录只接受"逐字回显同一对 (quote, text)"的结论', () => {
  it('三种结论各自落成一条记录，指纹由**生成侧**算出来', () => {
    const records = recordsFor(
      [
        { ...IMPACT, status: 'passed' },
        { ...SECOND, status: 'revised', revisedText: '期限届满后可继续收费。' },
      ],
      [IMPACT, SECOND],
    );
    assert.equal(records.length, 2);
    assert.equal(records[0].quoteFingerprint, quoteFingerprint(IMPACT.quote));
    assert.equal(records[0].textFingerprint, quoteFingerprint(IMPACT.text));
    assert.equal(records[1].status, 'revised');
    assert.equal(records[1].revisedText, '期限届满后可继续收费。');
  });

  it('**想换 quote** ⇒ 那条结论不被接受（只减不加：引用与条目集合冻结）', () => {
    const records = recordsFor([
      { ...IMPACT, quote: '另一句完全不同的原文', status: 'passed' },
    ]);
    assert.deepEqual(records, [], '换引用之后的结论挂不到任何判读上，不是"另立一条"');
  });

  it('**新增判读条目** ⇒ 多出来的那份结论不产生记录，已有的照常', () => {
    const records = recordsFor([
      { ...IMPACT, status: 'passed' },
      { quote: '凭空多出来的一条', text: '模型自己加的影响', status: 'passed' },
    ]);
    assert.equal(records.length, 1, '只能有一条：库里那一条');
    assert.equal(records[0].textFingerprint, quoteFingerprint(IMPACT.text));
  });

  it('端口对某条判读**一句话没说** ⇒ 那条没有记录（不补"通过"）', () => {
    const records = recordsFor([{ ...IMPACT, status: 'passed' }], [IMPACT, SECOND]);
    assert.equal(records.length, 1);
    assert.equal(records[0].textFingerprint, quoteFingerprint(IMPACT.text));
  });

  it('同一条判读收到**两份结论** ⇒ 那一对整份不采信（歧义比缺记录坏得多）', () => {
    const records = recordsFor([
      { ...IMPACT, status: 'passed' },
      { ...IMPACT, status: 'rejected' },
    ]);
    assert.deepEqual(records, []);
  });

  it('「已改」但没有文本 ⇒ 不采信（与读侧同一条）', () => {
    assert.deepEqual(recordsFor([{ ...IMPACT, status: 'revised', revisedText: '  ' }]), []);
    assert.deepEqual(recordsFor([{ ...IMPACT, status: 'revised' }]), []);
  });

  it('回显只差换行 / 全角空格 / 引号字形 ⇒ 照样配对（附着在原文上的空白不是内容）', () => {
    const spaced = { ...IMPACT, quote: `收费公路在收费偿债期间的\n　管理养护费用，在车辆通行费中列支。` };
    const records = recordsFor([{ ...spaced, status: 'passed' }]);
    assert.equal(records.length, 1);
    assert.equal(records[0].quoteFingerprint, quoteFingerprint(IMPACT.quote));
  });
});

describe('issue #47：指纹匹配（决定 19 —— 全等才算数）', () => {
  it('两个指纹全等 ⇒ 命中那一条', () => {
    const records = recordsFor([{ ...IMPACT, status: 'passed' }]);
    assert.notEqual(findImpactReview(records, IMPACT), null);
  });

  it('**生成侧重跑改了 text** ⇒ 旧记录对不上 ⇒ 视为没有记录（审读层自动失效）', () => {
    const records = recordsFor([{ ...IMPACT, status: 'revised', revisedText: '上一轮的改法' }]);
    const rerun = { ...IMPACT, text: '重跑之后模型换了一种说法。' };
    assert.equal(findImpactReview(records, rerun), null, '没被审读过的文本不许配着别人的结论');
  });

  it('引用改了（即使推断正文一字未动）⇒ 也不命中', () => {
    const records = recordsFor([{ ...IMPACT, status: 'passed' }]);
    assert.equal(findImpactReview(records, { ...IMPACT, quote: '另一句原文' }), null);
  });

  it('内容一字未变、只是空白不同（PDF 换行）⇒ 幂等有效', () => {
    const records = recordsFor([{ ...IMPACT, status: 'passed' }]);
    const same = { ...IMPACT, quote: `收费公路在收费偿债期间的管理养护费用，\n在车辆通行费中列支。` };
    assert.notEqual(findImpactReview(records, same), null);
  });

  it('空记录数组 ⇒ null（存量行、人工录入、审读没跑成都走这一支）', () => {
    assert.equal(findImpactReview([], IMPACT), null);
    assert.equal(findImpactReview(recordsFor([]), IMPACT), null);
  });
});
