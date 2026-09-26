import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SUMMARY_BASIS_LABELS,
  SUMMARY_BASIS_NOTES,
  SUMMARY_UPGRADE_LABELS,
  summaryProvenance,
  summaryTemplateOf,
} from '../../src/lib/summary-basis.ts';

/**
 * 单元（issue #83）：摘要依据的分类、模板版本与「还能不能靠重跑变好」。
 *
 * 这一组的价值在于**把三条正交的事实分开**：依据（输入是什么）、模板（哪版提示词）、
 * 可优化性（运营结论）。混成一条的后果是运营拿着"未优化"的名单去重跑 30 条
 * 没有附件的公示 —— 那 30 条每一次都会得到同样的结果。
 *
 * 形状全部来自 2026-09-26 生产只读实测（84 条有摘要：46 条附件要点已产出、
 * 6 条喂过附件但零要点、2 条有可读附件没喂、2 条附件读不到、28 条无附件）。
 */

/** 附件报告的三种形态（与 draftAvailability 的输入同一形状）。 */
const NO_ATTACHMENT_LIST = { total: 0, okFiles: 0, fedChars: 0 };
const READ_AND_FED = { total: 2, okFiles: 2, fedChars: 18_000 };
const READ_NOT_FED = { total: 2, okFiles: 2, fedChars: 0 };
const UNREADABLE = { total: 2, okFiles: 0, fedChars: 0 };

const CURRENT_JSON = { what: {}, explanationPoints: [], changes: [], changeMarkers: null };

describe('issue #83：摘要依据与可优化性', () => {
  it('依据：附件要点已产出 / 喂了但无条文可摘（这两种都是"读了附件"）', () => {
    const withPoints = summaryProvenance({
      attachment: READ_AND_FED,
      hasAttachmentPoints: true,
      template: 'current',
    });
    assert.equal(withPoints.basis, 'attachment-points');
    assert.equal(withPoints.state, 'optimized');

    // 名单 / 打包清单类：读了附件也喂了，但这篇公告本来就没有可逐条摘的条文 ——
    // 过去这种条目页面会写"上方「草案条文要点」摘自…"，而那一栏根本没渲染
    const noPoints = summaryProvenance({
      attachment: READ_AND_FED,
      hasAttachmentPoints: false,
      template: 'legacy',
    });
    assert.equal(noPoints.basis, 'attachment-no-points');
    assert.equal(noPoints.state, 'not-upgradable', '没有条文可摘，重跑也是同一个结果');
  });

  it('依据：附件能读却没喂 ⇒ 可重跑；附件读不到 / 没有附件 ⇒ 重跑无效', () => {
    const notFed = summaryProvenance({
      attachment: READ_NOT_FED,
      hasAttachmentPoints: false,
      template: 'current',
    });
    assert.equal(notFed.basis, 'attachment-unused');
    assert.equal(notFed.state, 'upgradable');

    for (const [attachment, basis] of [
      [UNREADABLE, 'attachment-unreadable'],
      [NO_ATTACHMENT_LIST, 'notice-only'],
    ]) {
      const provenance = summaryProvenance({ attachment, hasAttachmentPoints: false, template: 'legacy' });
      assert.equal(provenance.basis, basis);
      assert.equal(provenance.state, 'not-upgradable', `${basis} 重跑不会变好`);
    }
  });

  it('「抽取表里没行」不等于「没有随文附件」：没探测过就报未探测', () => {
    const provenance = summaryProvenance({
      attachment: null,
      hasAttachmentPoints: false,
      template: 'legacy',
    });
    assert.equal(provenance.basis, 'not-probed');
    assert.notEqual(provenance.basis, 'notice-only');
    assert.equal(provenance.state, 'not-upgradable');
  });

  it('模板：看键在不在，不看值空不空（旧行缺 explanationPoints 这个键）', () => {
    assert.equal(summaryTemplateOf(CURRENT_JSON), 'current', '值可以是空数组，键在就是新模板');
    assert.equal(summaryTemplateOf({ what: {}, keyPoints: [] }), 'legacy');
    // 键存在但值是 JSON null 也算"新代码写的"（新代码写的是 []，null 只会来自旧数据里
    // 被手工改过的行 —— 但这与"键缺席"仍是两件事，判定只看键）
    assert.equal(summaryTemplateOf({ explanationPoints: null }), 'current');
    assert.equal(summaryTemplateOf(null), 'legacy', '没有摘要时按旧模板处理，不抛错');
    assert.equal(summaryTemplateOf('{}'), 'legacy');
  });

  it('有附件依据 + 旧模板 ⇒ 未优化但可重跑（重跑能多出「编制说明要点」那一栏）', () => {
    const legacy = summaryProvenance({
      attachment: READ_AND_FED,
      hasAttachmentPoints: true,
      template: 'legacy',
    });
    assert.equal(legacy.state, 'upgradable');
    // 这正是 #83 里"该不该重跑"的分界：同样是旧模板，有没有附件依据结论相反
    const noAttachment = summaryProvenance({
      attachment: NO_ATTACHMENT_LIST,
      hasAttachmentPoints: false,
      template: 'legacy',
    });
    assert.equal(noAttachment.state, 'not-upgradable');
  });

  it('分类的词表是完整的：每一档都有中文名与一句说明', () => {
    const bases = [
      'attachment-points',
      'attachment-no-points',
      'attachment-unused',
      'attachment-unreadable',
      'notice-only',
      'not-probed',
    ];
    for (const basis of bases) {
      assert.ok(SUMMARY_BASIS_LABELS[basis]?.length > 0, `${basis} 缺中文名`);
      assert.ok(SUMMARY_BASIS_NOTES[basis]?.length >= 10, `${basis} 缺说明`);
    }
    assert.equal(Object.keys(SUMMARY_BASIS_LABELS).length, bases.length, '多出来的档位说明词表漂了');
    for (const state of ['optimized', 'upgradable', 'not-upgradable']) {
      assert.ok(SUMMARY_UPGRADE_LABELS[state]?.length > 0);
    }
    // 「未优化（可重跑）」与「未优化（重跑无效）」必须读起来是两件事 ——
    // 这是运营唯一能照做的判据，含糊就等于把时间花在不会变的事情上
    assert.notEqual(SUMMARY_UPGRADE_LABELS.upgradable, SUMMARY_UPGRADE_LABELS['not-upgradable']);
    assert.match(SUMMARY_UPGRADE_LABELS.upgradable, /可重跑/);
    assert.match(SUMMARY_UPGRADE_LABELS['not-upgradable'], /重跑无效/);
  });
});
