import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import {
  impactReviewCoverage,
  impactReviewRecordsFrom,
  parseImpactReviews,
  serializeImpactReviews,
} from '../../src/lib/impact-review.ts';
import { buildQuotedSummary, parseQuotedSummary } from '../../src/lib/summary-content.ts';

/**
 * 端到端（issue #51）：`review-impacts-now.mjs` —— **只审读、不重跑**。
 *
 * 这条通道存在的理由是具体的：门翻转（#52）之后"没有有效审读记录的判读一律不渲染"，
 * 而公众广域那几条线上正在渲染的判读**按重跑工具的判据不是候选**（摘要已经完整）
 * ⇒ 只靠重跑永远补不出"全库覆盖"，它们会在开门那一刻集体消失。
 *
 * 所以这里钉三件事：
 * ① 只读模式一个字都不写、一次调用都不发；
 * ② `--apply` **只写审读那一列** —— 摘要 JSON / 模型名 / 诊断一个字节都不许动
 *    （重写摘要等于白花一次生成调用，还会把"这份摘要是哪一次调用产出的"冲掉）；
 * ③ 覆盖判据与渲染门同一份（`impactReviewCoverage` 走 `findImpactReview`）：
 *    已经覆盖的那条不进缺口、不会被重复调用。
 *
 * 零外部依赖（ADR-0001）：临时 SQLite + stub 端口，脚本 import 的就是仓库源码。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-review-now-'));
const dbFile = path.join(workDir, 'app.db');

/** 有判读、**没有**审读记录（缺口就在这条上） */
const GAP = 'a1'.repeat(16);
/** 有判读、审读记录齐（不该被重复调用） */
const COVERED = 'c2'.repeat(16);
/** 没有判读（不在本工具范围内） */
const NO_IMPACTS = 'd3'.repeat(16);

const DRAFT = {
  name: '某规定（征求意见稿）.docx',
  url: 'https://source.test/draft.docx',
  text:
    '第一条 运输机场运营人应当取得许可，并在有效期届满前申请延续。\n'
    + '第二条 收费公路在收费偿债期间的管理养护费用，在车辆通行费中列支。',
};

function summaryWithImpacts() {
  return buildQuotedSummary(
    {
      what: '这是什么',
      who: '',
      afterDeadline: '',
      deadline: null,
      howToComment: '如何提意见',
      channels: [],
      impacts: [
        {
          quote: '运输机场运营人应当取得许可',
          who: '运输机场运营人',
          point: '取证成本',
          text: '取证成本可能上升。',
          kind: 'burden',
        },
        {
          quote: '收费公路在收费偿债期间的管理养护费用，在车辆通行费中列支。',
          who: '高速公路通行车主',
          point: '通行费用支出',
          text: '期限届满后可能继续收费。',
          kind: 'risk',
        },
      ],
    },
    undefined,
    [DRAFT],
  );
}

function reviewJsonFor(summary) {
  return serializeImpactReviews(
    impactReviewRecordsFrom({
      impacts: summary.impacts,
      verdicts: summary.impacts.map((impact) => ({
        quote: impact.quote,
        text: impact.text,
        status: 'passed',
      })),
      model: '既有审读模型',
      reviewedAt: '2026-10-04T00:00:00.000Z',
    }),
  );
}

let db;
let setColumns;

function runScript(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/review-impacts-now.mjs', ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DB_DRIVER: 'sqlite',
        DATABASE_URL: dbFile,
        LLM_PROVIDER: 'stub',
        MAILER_PROVIDER: 'stub',
        ATTACHMENT_TEXT: 'off',
        // 审读那一路（issue #47/#50）走 stub：缺省是**不跑**（`impactReviewReady()` 为假），
        // 而这几条要断言的正是"补出来的审读记录"。
        IMPACT_REVIEW_PROVIDER: 'stub',
        ...extraEnv,
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

const rowOf = (id) =>
  db
    .prepare(
      'select ai_summary_json as summary, summary_model as model, summary_diagnostics_json as diagnostics, impact_review_json as reviews from notices where id = ?',
    )
    .get(id);

before(async () => {
  process.env.DB_DRIVER = 'sqlite';
  process.env.DATABASE_URL = dbFile;

  const noticesRepo = await import('../../src/db/repo/notices.ts');
  const sourcesRepo = await import('../../src/db/repo/sources.ts');
  await sourcesRepo.registerSource({ id: 'e2e-review-now', name: '审读回填源', adapterType: 'fixture' });

  for (const [id, title] of [
    [GAP, '甲：有判读没审读'],
    [COVERED, '乙：审读已覆盖'],
    [NO_IMPACTS, '丙：没有判读'],
  ]) {
    await noticesRepo.upsertNotice({
      id,
      sourceId: 'e2e-review-now',
      title,
      agency: '测试机关',
      url: `https://source.test/${id}.html`,
      publishedAt: new Date().toISOString().slice(0, 10),
      deadlineAt: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10),
      status: 'open',
      bodyText: '现向社会公开征求意见。',
      attachments: [],
      fetchedAt: new Date().toISOString(),
    });
  }

  db = new Database(dbFile);
  setColumns = db.prepare(
    'update notices set ai_summary_json = ?, summary_model = ?, summary_diagnostics_json = ?, impact_review_json = ? where id = ?',
  );
});

beforeEach(() => {
  const withImpacts = JSON.stringify(summaryWithImpacts());
  const noImpacts = JSON.stringify(
    buildQuotedSummary({
      what: '这是什么',
      who: '',
      afterDeadline: '',
      deadline: null,
      howToComment: '如何提意见',
      channels: [],
    }),
  );
  // 甲：有判读、没有审读记录（缺口）；乙：有判读、审读记录齐；丙：没有判读
  setColumns.run(withImpacts, 'mimo-v2.5', '{"v":3,"model":"mimo-v2.5"}', null, GAP);
  setColumns.run(
    withImpacts,
    'mimo-v2.5',
    '{"v":3,"model":"mimo-v2.5"}',
    reviewJsonFor(summaryWithImpacts()),
    COVERED,
  );
  setColumns.run(noImpacts, 'mimo-v2.5', '{"v":3,"model":"mimo-v2.5"}', null, NO_IMPACTS);
});

describe('issue #51：只审读不重跑（review-impacts-now）', () => {
  it('只读：逐条列出覆盖与缺口，一个字都不写、一次调用都不发', async () => {
    const before = JSON.stringify(rowOf(GAP));
    const { code, output } = await runScript([]);
    assert.equal(code, 0, output);
    assert.match(output, /有判读的条目 2 条 \/ 判读 4 条：覆盖 2 条，\*\*缺口 2 条\*\*/);
    assert.match(output, /✔ c2c2c2c2  覆盖 2\/2/);
    assert.match(output, /缺口 a1a1a1a1  覆盖 0\/2/);
    assert.match(output, /缺口逐条/, '缺口的条目与引用要逐条列出来（回填要点名跑这些）');
    assert.match(output, /只读模式（未加 --apply）/);
    assert.equal(JSON.stringify(rowOf(GAP)), before, '只读模式一个字节都不许动');
  });

  it('--apply：只写审读那一列 —— 摘要 JSON / 模型名 / 诊断一个字节都不动', async () => {
    const before = rowOf(GAP);
    assert.equal(before.reviews, null, '前提：这条本来没有审读记录');

    const { code, output } = await runScript(['--apply', '--ids', GAP.slice(0, 8)]);
    assert.equal(code, 0, output);
    assert.match(output, /#BACKUP/, '写库之前要把旧值打到 stdout（权威副本）');
    assert.match(output, /写入审读记录 2\/2 条/);

    const after = rowOf(GAP);
    assert.equal(after.summary, before.summary, '摘要 JSON 必须一个字节不动（这条通道不重跑）');
    assert.equal(after.model, before.model, '模型名同理');
    assert.equal(after.diagnostics, before.diagnostics, '诊断同理（它描述的是产出这份摘要的那次调用）');

    const records = parseImpactReviews(after.reviews);
    assert.equal(records.length, 2, '两条判读各一份审读记录');
    assert.ok(records.every((item) => item.status === 'passed'));
    assert.equal(records[0].model, 'stub', '记录里带着审读模型名');

    // 覆盖判据与渲染门同一份：补完之后缺口为 0
    const coverage = impactReviewCoverage(
      parseQuotedSummary(JSON.parse(after.summary)).impacts,
      records,
    );
    assert.equal(coverage.missing.length, 0, '这一条的缺口应当被补平');
  });

  it('已经覆盖的那条不进缺口、不会被重复调用（幂等）', async () => {
    const coveredBefore = rowOf(COVERED).reviews;
    const { code, output } = await runScript(['--apply', '--all']);
    assert.equal(code, 0, output);
    assert.match(output, /✔ c2c2c2c2  覆盖 2\/2/, '只读那一段就说清了它不缺');
    assert.equal(rowOf(COVERED).reviews, coveredBefore, '已有记录不许被覆盖（幂等）');
    // 没有判读的条目根本不该出现在清单里
    assert.doesNotMatch(output, /d3d3d3d3/);
  });

  it('点名不存在 / 前缀不唯一：当场报错退出，一个字节都不改', async () => {
    const before = rowOf(GAP).reviews;
    const unknown = await runScript(['--apply', '--ids', 'deadbeef']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.output, /没有"以它开头、有判读、且有缺口"的条目/);

    // a1 与 c2 都是缺口的候选名（这里 c2 已覆盖 ⇒ 点名它同样算"没有缺口"）
    const coveredNamed = await runScript(['--apply', '--ids', COVERED.slice(0, 8)]);
    assert.equal(coveredNamed.code, 1);
    assert.match(coveredNamed.output, /没有"以它开头、有判读、且有缺口"的条目/);
    assert.equal(rowOf(GAP).reviews, before, '报错路径一个字都不许改');
  });

  it('审读端口没配：退出码非 0，且**一条都不写**（不是"写了空记录"）', async () => {
    const before = rowOf(GAP).reviews;
    const { code, output } = await runScript(['--apply', '--all'], {
      IMPACT_REVIEW_PROVIDER: '',
    });
    assert.equal(code, 1, output);
    assert.match(output, /审读未成（not-configured/);
    assert.match(output, /缺口为 0/, '回填的验收是缺口为 0，没跑成要吵出来');
    assert.equal(rowOf(GAP).reviews, before, '跑不成就别写（写了空记录会让下一轮不再试）');
  });
});
