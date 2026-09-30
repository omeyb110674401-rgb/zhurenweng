import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  coverageGapAttribution,
  feedIntakeSentence,
  feedReportedGap,
} from '../../src/lib/explanation-coverage.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readRepoFile = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/**
 * 单元：**读者侧终于拿得到"本轮喂了几份、几份被截"**（issue #86 §19.4 那条债的收尾）。
 *
 * 为什么这一组值得单独存在：两处覆盖度文案从前各说各的，而且都在替差额**猜**一个原因
 * （"其余的不在本站读到的那一截里"，实测里那句话是假的：说明整份都在窗口内、`truncated`
 * 全为 false，模型仍然只列出三分之一的小节）。修法不是把那句话换个说法，而是把
 * **本站真的读到的那个事实**（`summary_diagnostics_json.feed`）接到读者侧，让两处共用同一句。
 *
 * 所以这里钉三层：
 * ① 清单 → 一句诚实话（份数 / 被截份数 / 喂进多少汉字；没截就不许提截断）；
 * ② "我们没读到"这句话**唯一**允许出现的条件（`feedReportedGap`）；
 * ③ 这条链在页面上真的接通了（三个文件各自那一行 —— 页面 `.tsx` 进不了渲染单测，
 *    与 `summary-display.test.mjs` 里"详情页把附件报告接到了摘要卡"同一条路数）。
 */

/** 一份喂入清单（形状 = `summary_diagnostics_json.feed`）。 */
const feedOf = (overrides = {}) => ({
  tier: 'deep',
  budget: { perSource: 16_000, total: 24_000, minShare: 4_000 },
  usedCjk: 0,
  sources: [],
  starved: [],
  ...overrides,
});

const fedSource = (overrides = {}) => ({
  name: '某某法（修正草案征求意见稿）编制说明.docx',
  role: 'explanation',
  origin: 'attachment',
  fullCjk: 12_400,
  fedCjk: 2_753,
  chars: 8_000,
  allowance: 8_000,
  truncated: false,
  ...overrides,
});

describe('issue #86 §19.4：喂入清单 → 一句诚实话', () => {
  it('一份被截 ⇒ 说清读到几份、几份被截（不写"没有一份被截"）', () => {
    const sentence = feedIntakeSentence(
      feedOf({
        usedCjk: 4_000,
        sources: [
          fedSource({ truncated: true, fedCjk: 2_753 }),
          fedSource({ name: '某某法（草案）.docx', role: 'draft', fedCjk: 1_247 }),
        ],
      }),
    );
    assert.match(sentence, /本轮读到 2 份来源，共喂进模型 4000 个汉字/);
    assert.match(sentence, /其中 1 份只喂进一部分（被截）/);
    assert.doesNotMatch(sentence, /没有一份被截/);
  });

  it('每一份都整份进了窗口 ⇒ 只在这一种情形下说"没有一份被截"', () => {
    const sentence = feedIntakeSentence(
      feedOf({ usedCjk: 2_753, sources: [fedSource()] }),
    );
    assert.match(sentence, /本轮读到 1 份来源，共喂进模型 2753 个汉字/);
    assert.match(sentence, /每一份都整份进了窗口，没有一份被截/);
    assert.doesNotMatch(sentence, /只喂进一部分/);
  });

  it('一个字都没喂进去的那些也要报（这一项就是这个清单存在的理由）', () => {
    const exactlyTwo = feedIntakeSentence(
      feedOf({
        sources: [fedSource()],
        starved: [{ name: '某某法（修正草案征求意见稿）起草说明.docx', fullCjk: 6_000 }],
      }),
    );
    assert.match(exactlyTwo, /本轮读到 2 份来源/);
    assert.match(exactlyTwo, /其中 1 份一个字都没喂进去/);
    const allStarved = feedIntakeSentence(
      feedOf({ starved: [{ name: '某某法（草案）.docx', fullCjk: 6_000 }] }),
    );
    assert.match(allStarved, /本轮读到 1 份来源，但一份都没喂进模型/);
    const nothing = feedIntakeSentence(feedOf());
    assert.match(nothing, /本轮没有把任何来源喂进模型/);
  });

  it('没有清单就一个字都不说（不编一份空的出来）', () => {
    assert.equal(feedIntakeSentence(null), '');
    assert.equal(feedIntakeSentence(undefined), '');
    assert.equal(coverageGapAttribution(null, '说明小节'), '这条摘要没有留下本轮的喂入记录，差额出在哪一环本站给不出可核对的答案。');
  });

  it('按来源类别过滤：份数与汉字数都只算这一类（拿整次调用的数会说错话）', () => {
    const feed = feedOf({
      usedCjk: 9_000,
      sources: [
        fedSource(),
        fedSource({ name: '某某法（修正草案征求意见稿）.docx', role: 'draft', fedCjk: 6_247, truncated: true }),
      ],
    });
    const sentence = feedIntakeSentence(feed, 'explanation');
    assert.match(sentence, /本轮读到 1 份说明类来源，共喂进模型 2753 个汉字/);
    assert.match(sentence, /没有一份被截/, '被截的是条文类那一份，说明这一栏不许跟着说被截');
    // 不过滤时那两个数都要出现（页面那一栏说的是整次调用）
    const all = feedIntakeSentence(feed);
    assert.match(all, /本轮读到 2 份来源，共喂进模型 9000 个汉字/);
    assert.match(all, /其中 1 份只喂进一部分（被截）/);
  });
});

describe('issue #86 §19.4："我们没读到"唯一允许出现的条件', () => {
  it('清单没报缺口（没截、没饿着）⇒ 不许说"没读到"，差额归给模型没写', () => {
    const feed = feedOf({ sources: [fedSource()] });
    assert.equal(feedReportedGap(feed), false);
    const clause = coverageGapAttribution(feed, '说明小节', 'explanation');
    assert.match(clause, /差额来自模型没有把检测到的说明小节都写出来/);
    assert.doesNotMatch(clause, /没喂进去的那一截/);
    assert.doesNotMatch(clause, /本站没读到/);
  });

  it('被截 / 饿着 ⇒ 才允许把"没喂进去的那一截"作为一种可能说出来', () => {
    assert.equal(feedReportedGap(feedOf({ sources: [fedSource({ truncated: true })] })), true);
    assert.equal(feedReportedGap(feedOf({ starved: [{ name: '某某法（草案）.docx', fullCjk: 900 }] })), true);
    const clause = coverageGapAttribution(
      feedOf({ sources: [fedSource({ truncated: true })] }),
      '说明小节',
      'explanation',
    );
    assert.match(clause, /差额可能出在没喂进去的那一截上，也可能来自模型没有把检测到的说明小节都写出来/);
  });

  it('没有清单就是没有清单（不当作"报了缺口"，也不当作"没截"）', () => {
    assert.equal(feedReportedGap(null), false);
    assert.equal(feedReportedGap(undefined), false);
    assert.match(coverageGapAttribution(undefined, '改动表述'), /没有留下本轮的喂入记录/);
  });
});

describe('issue #86 §19.4：这条链在页面上真的接通了', () => {
  it('仓储层把诊断那一列查出来（不查，读者侧永远只有"没有喂入记录"）', () => {
    const repo = readRepoFile('src/db/repo/summaries.ts');
    assert.match(repo, /summaryDiagnosticsJson: notices\.summaryDiagnosticsJson,/);
    assert.match(repo, /summaryDiagnosticsJson: string \| null;/, 'NoticeSummaryInfo 要带上这一列');
  });

  it('详情页读出 feed 并传给摘要卡（读到却不传 = 白读）', () => {
    const page = readRepoFile('src/app/notices/[id]/page.tsx');
    assert.match(
      page,
      /parseSummaryDiagnostics\(safeParseJson\(summaryInfo\?\.summaryDiagnosticsJson \?\? null\)\)\?\.feed/,
      '详情页要真的去解析诊断那一列',
    );
    assert.match(page, /feedReport=\{feedReport\}/, '解析出来却不在传给摘要卡 = 白解析');
  });

  it('摘要卡把清单交给两处覆盖度判据（只接一处 ⇒ 两栏说法不一致）', () => {
    const view = readRepoFile('src/app/_lib/summary-view.tsx');
    assert.match(view, /changeTableNote\(\s*\{[\s\S]*?\},\s*feedReport,?\s*\)/, '改动表那一句要带上清单');
    assert.match(view, /changeCoverageVerdict\(changes\.length, summary\.changeMarkers, feedReport\)/);
    assert.match(
      view,
      /explanationCoverageVerdict\(\s*points\.length,\s*summary\.explanationSections,\s*feedReport,?\s*\)/,
      '编制说明那一栏也要带上同一份清单',
    );
  });

  it('验收门（scripts/show-notice-summary.mjs）印的与页面同源', () => {
    const gate = readRepoFile('scripts/show-notice-summary.mjs');
    assert.match(gate, /const feed = diagnostics\?\.feed \?\? null;/, '门要从落库的诊断里取同一份清单');
    assert.match(gate, /changeTableNote\(\s*\{[\s\S]*?\},\s*feed,?\s*\)/);
    assert.match(gate, /changeCoverageVerdict\(changes\.length, markers, feed\)/);
    assert.match(
      gate,
      /explanationCoverageVerdict\(\s*parsed\.explanationPoints\.length,\s*parsed\.explanationSections,\s*feed,?\s*\)/,
      '这一栏的覆盖度此前门上看不见 —— 补上它，门才知道页面那一行说了什么',
    );
  });
});
