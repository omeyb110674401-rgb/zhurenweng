import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { NOTICE_MARK_HINTS, NOTICE_MARK_LABELS, noticeMarks } from '../../src/lib/notice-marks.ts';
import { impactsToRender } from '../../src/lib/impact-display.ts';
import { impactReviewRecordsFrom } from '../../src/lib/impact-review.ts';

/**
 * 单元：列表页的「这条里有什么」标记（issue #87，2026-10-03 拍板）。
 *
 * 这一组钉的是**同一道门**那件事，不是文案：
 * 生产库里有一批 `sector` 条目**存着判读但详情页一个字都不渲染**（受众面门控）。
 * 列表页若照库里的数组打标记，读者点进去会发现什么都没有 —— 列表在承诺详情页不存在的东西，
 * 那比没有标记坏得多。所以第 2、7 条是这一组的重心。
 *
 * 判据抽在 `lib/notice-marks.ts` 而不是写在组件里，为的就是这一组能跑起来 ——
 * 页面 `.tsx` 进不了本仓库的单测（`check-test-pins.mjs` 硬规则第 1 条：e2e 跑的是 `.next`
 * 构建产物，撤 `src/app/**` 撤不出红）。**怎么画**留给组件，由最后一组按源码钉接线。
 *
 * issue #47 又给这道门加了一维输入：**审读**。某条判读被审读剔除之后详情页不再渲染它，
 * 列表也就必须跟着不打标 —— 那条 4×2 的契约测试因此扩成 4×2×4（受众面 × 有没有判读 ×
 * 审读结论）。这正是它存在的意义：每次门一改形状，它就会在"两边各说各话"之前先红。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readRepoFile(relative) {
  return readFileSync(path.join(repoRoot, relative), 'utf8');
}

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

/** 只给 `noticeMarks` 真读的那三个键；其余键与判据无关。 */
function summary(parts = {}) {
  return { impacts: [], changes: [], changeTable: null, ...parts };
}

/**
 * 一条审读记录（issue #47）：走**写侧**造出来 —— 指纹的口径只有一处（生成侧的
 * `quoteFingerprint`），测试里手抄一份就会在口径变动时静默过期。
 */
function reviewRecords(status) {
  return impactReviewRecordsFrom({
    impacts: [IMPACT],
    verdicts: [
      {
        quote: IMPACT.quote,
        text: IMPACT.text,
        status,
        revisedText: status === 'revised' ? '审读后：通行者的支出预期被改变。' : null,
      },
    ],
    model: 'stub',
    reviewedAt: '2026-10-04T12:00:00.000Z',
  });
}

describe('issue #87 / #52：列表标记的判据（只说"有"，不说"无"）', () => {
  it('有有效审读记录 ⇒ 含 impacts（门放行，列表就跟着打标）', () => {
    assert.deepEqual(
      noticeMarks({ summary: summary({ impacts: [IMPACT] }), reviews: reviewRecords('passed') }),
      ['impacts'],
    );
    assert.deepEqual(
      noticeMarks({ summary: summary({ impacts: [IMPACT] }), reviews: reviewRecords('revised') }),
      ['impacts'],
    );
  });

  it('**没有审读记录 ⇒ 不打标**（#52 起门是 fail-closed，详情页一个字都不渲染）', () => {
    assert.deepEqual(noticeMarks({ summary: summary({ impacts: [IMPACT] }) }), []);
    assert.deepEqual(
      noticeMarks({ summary: summary({ impacts: [IMPACT] }), reviews: [] }),
      [],
      '空记录与没传记录是同一件事 —— 列表不许承诺详情页不存在的东西',
    );
  });

  it('受众面**不再是判据**：行业专业 / 未判定 + 有效记录 ⇒ 与公众广域一样打标', () => {
    // #52 之前这三个受众面一律不打标（那时候门里还有受众面）；现在门只认审读记录，
    // 列表必须跟着走 —— 否则行业档的读者在列表上看不到标记、点进去却有内容。
    // （`noticeMarks` 的入参里已经**没有** audience 了：用不上的入参就是下一轮的幽灵旋钮。）
    assert.deepEqual(
      noticeMarks({ summary: summary({ impacts: [IMPACT] }), reviews: reviewRecords('passed') }),
      ['impacts'],
    );
  });

  it('判读为空数组 ⇒ 不含 impacts（空壳比没有更坏，与详情页同一条）', () => {
    assert.deepEqual(noticeMarks({ summary: summary() }), []);
  });

  it('改动对照：`changes` 非空而 `changeTable` 为 null（历史行）⇒ 含 changes', () => {
    assert.deepEqual(
      noticeMarks({ summary: summary({ changes: [{ clause: '第三十六条' }] }) }),
      ['changes'],
    );
  });

  it('改动对照：`changeTable` 非空而 `changes` 为空 ⇒ **也**含 changes（与详情页那个提前返回逐字对齐）', () => {
    assert.deepEqual(
      noticeMarks({ summary: summary({ changeTable: { entries: [], headers: 0 } }) }),
      ['changes'],
    );
  });

  it('摘要为 null（没生成 / 旧形状解析失败）⇒ 空数组，且不抛错', () => {
    assert.deepEqual(noticeMarks({ summary: null }), []);
    assert.deepEqual(noticeMarks({ summary: null, reviews: reviewRecords('passed') }), []);
  });

  it('既没有判读也没有改动对照 ⇒ 空数组（不许出现「暂无判读」那类灰标记）', () => {
    assert.deepEqual(noticeMarks({ summary: summary() }), []);
  });

  it('两种都有 ⇒ impacts 在前（判读是更值得读的那一段）', () => {
    assert.deepEqual(
      noticeMarks({
        summary: summary({ impacts: [IMPACT], changes: [{ clause: '第五十八条第二款' }] }),
        reviews: reviewRecords('passed'),
      }),
      ['impacts', 'changes'],
    );
  });

  /**
   * 契约测试：把"同一道门"钉成**可执行**的东西，而不是注释里的一句话。
   * 有效组合是 2×4 种（有没有判读 × 审读结论）—— #52 起受众面**不在输入空间里**了
   * （它已退出判据），所以这一格从矩阵里消失，而"两边逐格对齐"这件事一个字没变。
   */
  it('契约：impacts 那一支的结论与 `impactsToRender` 逐格一致（同一道门）', () => {
    const reviewCases = [
      { label: '没有记录', reviews: [] },
      { label: '通过', reviews: reviewRecords('passed') },
      { label: '已改', reviews: reviewRecords('revised') },
      { label: '剔除', reviews: reviewRecords('rejected') },
    ];
    for (const impacts of [[], [IMPACT]]) {
      for (const { label, reviews } of reviewCases) {
        const viaMarks = noticeMarks({ summary: summary({ impacts }), reviews }).includes('impacts');
        const viaGate = impactsToRender({ impacts, reviews }) !== null;
        assert.equal(
          viaMarks,
          viaGate,
          `impacts=${impacts.length} 审读=${label}：列表标记与详情页门控结论必须一致`,
        );
      }
    }
  });

  it('审读把唯一一条**剔除** ⇒ 不打标（列表不许承诺详情页不存在的东西）', () => {
    assert.deepEqual(
      noticeMarks({ summary: summary({ impacts: [IMPACT] }), reviews: reviewRecords('rejected') }),
      [],
    );
  });

  it('审读**已改** ⇒ 照常打标（那一段还在，只是换了文本 —— 标记说的是"这里有判读"）', () => {
    assert.deepEqual(
      noticeMarks({ summary: summary({ impacts: [IMPACT] }), reviews: reviewRecords('revised') }),
      ['impacts'],
    );
  });

  it('措辞不许被悄悄改软：impacts 的文案含「推断」与「非官方」', () => {
    assert.match(NOTICE_MARK_LABELS.impacts, /推断/, '主词必须是「推断」（与详情页段内声明同一个词）');
    assert.match(NOTICE_MARK_LABELS.impacts, /非官方/, '这三个字是这句话里最要紧的');
    assert.match(NOTICE_MARK_LABELS.changes, /改动对照/);
    assert.match(NOTICE_MARK_HINTS.impacts, /不是官方表述/, '悬停说明与详情页那段块级声明同义');
    assert.ok(NOTICE_MARK_HINTS.changes.length > 0, '改动对照也要有完整说明');
  });
});

/**
 * 接线（源码）：判据写对了、组件没接上，是这一类改动最常见的断线 ——
 * 而它恰恰在 e2e 里**看不见**（构建产物照旧）。所以与 `who-display.test.mjs`
 * 钉 `shouldRenderWho` 同一手法，按**源码**钉两件事：首页那一条路径接上了，
 * 搜索页那一条**显式**关掉了（用户 2026-10-03 拍板"只首页"）。
 */
describe('issue #87：接线（源码）', () => {
  const item = readRepoFile('src/app/_lib/notice-item.tsx');

  it('组件真的用了 noticeMarks，并把解析后的摘要**与审读记录**一起喂给它', () => {
    assert.match(
      item,
      /noticeMarks\(\{[\s\S]*?summary: parseQuotedSummary\(notice\.aiSummary\),[\s\S]*?reviews: notice\.impactReviews,[\s\S]*?\}\)/,
      '判据必须走 lib/notice-marks.ts，而不是在组件里另写一个 if；审读记录也要喂进同一道门（否则列表会承诺详情页已剔除或无记录的判读）',
    );
  });

  it('标记真的被画出来（testid 与 data-mark 都在）', () => {
    assert.match(item, /data-testid="notice-mark"/);
    assert.match(item, /data-mark=\{mark\}/, 'e2e 要能分辨是 impacts 还是 changes，而不是只数个数');
    assert.match(item, /title=\{NOTICE_MARK_HINTS\[mark\]\}/, '完整说明必须挂 title（读屏与悬停都拿得到）');
  });

  it('搜索页显式关掉标记（组件默认是开着的，例外必须写在例外发生的地方）', () => {
    const search = readRepoFile('src/app/search/page.tsx');
    assert.match(search, /<NoticeItem[^>]*showMarks=\{false\}/, '用户拍板"标记只放首页"');
  });
});
