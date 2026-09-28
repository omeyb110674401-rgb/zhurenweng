import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SUMMARY_TIERS,
  emptyFeedReport,
  feedAllowance,
  feedFitsAll,
  summaryTierFor,
} from '../../src/lib/attachment-feed.ts';
import {
  MAX_FILES_PER_NOTICE,
  PROMPT_CHARS_PER_ATTACHMENT,
  TARGET_TOTAL_CJK_CHARS,
} from '../../src/lib/attachment-select.ts';

/**
 * 单元：摘要喂入侧的档位与预算（issue #86 第 3 刀）。
 *
 * 这一组判据都朝着一个失效模式钉：**内容被静默丢掉**。它此前有三种丢法，且都不留痕迹 ——
 * 后面那一份拿不到预算就整份不送、拿到几百字就只送几百字、超过了就被适配器切掉尾巴。
 * 所以断言里最要紧的两条是"标准档与旧公式逐个相同"（证明这一刀没有偷改行业专业那一档）
 * 与"重档下那两份条文整份进得去"（证明它真的解决了 `41f2e22e` 那个实测病例）。
 */

/** 这一刀之前的公式（`min(单份上限, 总预算 - 已用)`）—— 留着当对照物，不要改成新公式。 */
function legacyAllowance(used, budget) {
  return Math.max(0, Math.min(budget.perSource, budget.total - used));
}

describe('喂入档位：只有公众广域走重档', () => {
  it('public ⇒ 重档', () => {
    assert.equal(summaryTierFor('public'), 'deep');
  });

  it('判不出来就当标准档（分类器的未知值不该换来一次加倍的调用成本）', () => {
    for (const value of ['sector', 'unknown', '', 'PUBLIC', '公众广域', 'public ', null, undefined]) {
      assert.equal(summaryTierFor(value), 'standard', `${JSON.stringify(value)} 应回标准档`);
    }
  });

  it('标准档的数字就是这一刀之前那两个老常量（不是各抄一份）', () => {
    assert.equal(SUMMARY_TIERS.standard.perSource, PROMPT_CHARS_PER_ATTACHMENT);
    assert.equal(SUMMARY_TIERS.standard.total, TARGET_TOTAL_CJK_CHARS);
  });

  it('重档每一处都不小于标准档，且至少放宽了一倍的单份上限', () => {
    const { standard, deep } = SUMMARY_TIERS;
    assert.ok(deep.perSource >= standard.perSource);
    assert.ok(deep.total >= standard.total);
    assert.ok(deep.minShare >= standard.minShare);
    assert.ok(deep.draftBlockChars >= standard.draftBlockChars);
    assert.ok(deep.explanationBlockChars >= standard.explanationBlockChars);
    assert.ok(deep.perSource >= standard.perSource * 2, '重档要真的更宽，否则这个档就是空档');
  });

  it('两段正文的最后一道防线都放得下"一份窗口"（否则它切掉的是预算允许喂进去的内容）', () => {
    for (const [tier, budget] of Object.entries(SUMMARY_TIERS)) {
      assert.ok(
        budget.draftBlockChars >= budget.perSource,
        `${tier} 档的 draftBlockChars 比单份窗口还小`,
      );
      assert.ok(
        budget.explanationBlockChars >= budget.perSource,
        `${tier} 档的 explanationBlockChars 比单份窗口还小 —— 一份说明都装不下`,
      );
    }
  });

  it('重档的防线放得下"两份窗口"（标准档放不下，那是继承来的紧，本刀刻意不动）', () => {
    assert.ok(SUMMARY_TIERS.deep.draftBlockChars >= SUMMARY_TIERS.deep.perSource * 2);
    assert.ok(SUMMARY_TIERS.deep.explanationBlockChars >= SUMMARY_TIERS.deep.perSource * 2);
    // 标准档：单份 8,000 的两份说明合计 16,000 > 10,000 ⇒ 第二份的尾部会被切掉。
    // 这是**继承来的**（10,000 这个数在 #76 就在），本刀按"行业专业那一档行为逐条不变"
    // 的取舍不动它，登记在 FOLLOWUPS 里等一次实测再定。
    assert.ok(SUMMARY_TIERS.standard.explanationBlockChars < SUMMARY_TIERS.standard.perSource * 2);
    assert.ok(
      SUMMARY_TIERS.standard.explanationBlockChars >= SUMMARY_TIERS.standard.perSource,
      '至少一份说明要装得下',
    );
  });

  it('附件份数 × 保底份额 ≤ 总预算（否则"保底"本身就是一句空话）', () => {
    for (const [tier, budget] of Object.entries(SUMMARY_TIERS)) {
      assert.ok(
        MAX_FILES_PER_NOTICE * budget.minShare <= budget.total,
        `${tier} 档：${MAX_FILES_PER_NOTICE} 份的保底加起来超过了总预算`,
      );
    }
  });
});

describe('配额分配：装得下就一份不截，装不下才动用保底', () => {
  const standard = SUMMARY_TIERS.standard;

  /**
   * 实测那一批（2026-09-27，`scripts/audit-draft-window.mjs 41f2e22edef76d7e` 在生产的输出）：
   * 三份附件分别被送进 7,973 / 7,973 / 6,249 字符，汉字 2,753 / 2,972 / 2,188，合计 7,913。
   * 第一份的原文字数远大于窗口（`char_count` 35,980，窗口切到 7,973）。
   */
  const MEASURED = [
    { chars: 39_000, cjk: 12_400 },
    { chars: 7_973, cjk: 2_972 },
    { chars: 6_249, cjk: 2_188 },
  ];

  it('实测那一批"全都装得下"⇒ 一份都不截（与线上今天喂进去的那一截逐个相同）', () => {
    // 三份窗口的汉字数就是实测送进去的那三截：2,753 / 2,972 / 2,188
    assert.equal(feedFitsAll([2_753, 2_972, 2_188], standard.total), true);
    // 装得下时每一份的配额就是单份上限（`excerptForPrompt` 对短文本会整份返回）
    assert.equal(Math.min(MEASURED[1].chars, standard.perSource), MEASURED[1].chars);
    assert.equal(Math.min(MEASURED[2].chars, standard.perSource), MEASURED[2].chars);
    assert.equal(Math.min(MEASURED[0].chars, standard.perSource), standard.perSource);
  });

  it('实测那一批在重档下第一份读到的是一倍（8,000 → 16,000 字符的窗口）', () => {
    assert.equal(feedFitsAll([2_753, 2_972, 2_188], SUMMARY_TIERS.deep.total), true);
    assert.equal(Math.min(MEASURED[0].chars, SUMMARY_TIERS.deep.perSource), 16_000);
    assert.ok(SUMMARY_TIERS.deep.perSource > standard.perSource);
  });

  it('"装得下"看的是窗口里的汉字数，不是原文的（同一份附件两种密度给出相反答案）', () => {
    // 实测那份编制说明：原文约 12,400 汉字，但 8,000 字符的窗口里只有 2,753 个
    assert.equal(feedFitsAll([2_753, 2_972, 2_188], standard.total), true, '按窗口算 ⇒ 装得下');
    assert.equal(
      feedFitsAll([8_000, 2_972, 2_188], standard.total),
      false,
      '若把那份按"最多能占满单份上限"算 ⇒ 会误判成装不下（这正是要避免的那种误判）',
    );
  });

  it('三份纯中文草案（装不下）⇒ 最后一份仍然拿得到保底', () => {
    // 形状是合成的那一类：三份都是纯中文草案，汉字密度 0.9 ⇒ 两个 8,000 字符的窗口就吃掉 14,400 汉字
    const denseWindows = [7_200, 7_200, 2_700];
    assert.equal(feedFitsAll(denseWindows, standard.total), false, '这一批装不下，才轮到保底那一支');
    // 第一份吃满单份上限（保底不会让它拿得更少）
    assert.equal(feedAllowance([18_000, 2_700], { used: 0, budget: standard }), standard.perSource);
    // 第二份被压到"总预算 - 已用 - 替第三份留的 1,500"
    const second = feedAllowance([2_700], { used: 7_200, budget: standard });
    assert.equal(second, standard.total - 7_200 - standard.minShare);
    assert.ok(second < 4_800, '这一支下中间那份确实要让一点额度出来');
    // 第三份：旧公式下只剩 480 字符（12,000 - 11,520），保底这一支拿到一千八百多
    const usedBeforeThird = 7_200 + 2_970;
    const third = feedAllowance([], { used: usedBeforeThird, budget: standard });
    assert.equal(third, standard.total - usedBeforeThird);
    assert.ok(third > 480 * 3, `最后一份不该只剩几百字，实际 ${third}`);
  });

  it('只有一两份时保底咬不到（与旧公式逐个相同）', () => {
    // n = 1
    assert.equal(feedAllowance([], { used: 0, budget: standard }), legacyAllowance(0, standard));
    // n = 2：单份上限 + 保底仍小于总预算 ⇒ 第一份照样吃满
    for (const rest of [19_815, 1_141, 300]) {
      assert.equal(
        feedAllowance([rest], { used: 0, budget: standard }),
        standard.perSource,
        `后面那份 ${rest} 汉字时，第一份仍应吃满`,
      );
    }
    // n = 2 的第二份：后面没人了 ⇒ 保底为 0，与旧公式同一个数
    for (const used of [0, 3_000, 7_200, 11_999]) {
      assert.equal(
        feedAllowance([], { used, budget: standard }),
        legacyAllowance(used, standard),
        `used=${used} 时第二份的配额应与旧公式一致`,
      );
    }
  });

  it('保底只替"用得完的那些"留（300 字的附件不许占住 1,500 的额度）', () => {
    const tiny = feedAllowance([300], { used: 10_000, budget: standard });
    const small = feedAllowance([1_500], { used: 10_000, budget: standard });
    // 后面只剩 300 字 ⇒ 只替它留 300，剩下的额度还给当前这一份；
    // 后面有 1,500 字 ⇒ 替它留满 1,500。差额正好是"那一份真的用得完的部分"。
    assert.equal(tiny - small, 1_200);
    assert.ok(tiny > small, '后面那份越小，当前这份越该多拿 —— 留出来花不掉的额度是净损失');
  });

  it('预算真的用光时返回 0（不给负数、也不给空头额度）', () => {
    assert.equal(feedAllowance([], { used: standard.total, budget: standard }), 0);
    assert.equal(feedAllowance([], { used: standard.total + 5_000, budget: standard }), 0);
    assert.equal(feedAllowance([9_000], { used: standard.total, budget: standard }), 0);
  });

  it('永远不超过单份上限（无论后面还剩多少）', () => {
    for (const used of [0, 1, 4_000]) {
      assert.ok(feedAllowance([], { used, budget: standard }) <= standard.perSource);
    }
  });

  it('"全都装得下"的判据是保守的：只要窗口汉字数之和没超预算就一定不超', () => {
    assert.equal(feedFitsAll([8_000, 4_000], standard.total), true);
    assert.equal(feedFitsAll([8_000, 4_001], standard.total), false);
    assert.equal(feedFitsAll([], standard.total), true, '一份都没有 ⇒ 空批次也算"装得下"');
  });
});

describe('喂入清单：形状与"没喂进去"的留痕', () => {
  it('空清单带着档位与预算一起出来（读的人不用去猜是哪个档）', () => {
    const report = emptyFeedReport('deep');
    assert.equal(report.tier, 'deep');
    assert.deepEqual(report.budget, {
      perSource: SUMMARY_TIERS.deep.perSource,
      total: SUMMARY_TIERS.deep.total,
      minShare: SUMMARY_TIERS.deep.minShare,
    });
    assert.deepEqual(report.sources, []);
    assert.deepEqual(report.starved, []);
    assert.equal(report.usedCjk, 0);
  });

  it('预算里给的三项与档位表同源（改一处不会两处不一致）', () => {
    for (const tier of ['standard', 'deep']) {
      const report = emptyFeedReport(tier);
      assert.equal(report.budget.perSource, SUMMARY_TIERS[tier].perSource);
      assert.equal(report.budget.total, SUMMARY_TIERS[tier].total);
      assert.equal(report.budget.minShare, SUMMARY_TIERS[tier].minShare);
    }
  });

  it('同一批输入给出同一个结果（预算是确定的，不做随机或时间相关的分配）', () => {
    const state = { used: 3_000, budget: SUMMARY_TIERS.standard };
    assert.equal(feedAllowance([2_000, 2_000], state), feedAllowance([2_000, 2_000], state));
  });
});
