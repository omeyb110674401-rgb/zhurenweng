import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { startAppServer } from './helpers/app-server.mjs';
import { createFixtureServer } from './helpers/fixture-server.mjs';
import { noticeItems, stripSsrComments as stripComments } from './helpers/html.mjs';

/**
 * E2E（issue #76）：体裁要**读者看得见**，而且必须是真跑一轮抓取之后的结果。
 *
 * 为什么值得为一个小角标开一条 e2e：判定的输入来自三个地方（标题、附件名、附件正文），
 * 其中两个要等 worker 的抽取任务。单测只能证明纯函数对，证明不了
 * 「抓取入库 → 判定落库 → 详情页读到它」这条链是通的 —— 而 #68/#70 的教训正是
 * 链条中间断一环，两端各自都"看起来正常"。
 *
 * 断言刻意只依赖真实 fixture 的标题形状：
 * - 交通运输部那条是「公路法（**修正草案**征求意见稿）」⇒ 修正案；
 * - 工业和信息化部那条是「无线电频率划分**规定**（征求意见稿）」⇒ 新案草案。
 * 这两类正好是读者最需要在开读前知道自己拿的是哪一种的两种。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures', 'e2e-sources');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-genre-'));
const dbFile = path.join(workDir, 'app.db');

const AMENDMENT_TITLE = '关于《中华人民共和国公路法（修正草案征求意见稿）》公开征求意见的通知';
const NEW_DRAFT_TITLE = '公开征求对《中华人民共和国无线电频率划分规定（征求意见稿）》的意见';

let app;
let fixtures;

function runWorkerOnce() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['worker/index.ts'], {
      cwd: repoRoot,
      env: { ...process.env, WORKER_ONCE: '1' },
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

async function detailOf(title) {
  const list = await (await fetch(`${app.url}/`)).text();
  for (const block of noticeItems(list)) {
    const anchor = /<a[^>]*notice-title-link[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/.exec(block);
    if (anchor && anchor[2].trim() === title) {
      const response = await fetch(`${app.url}${anchor[1]}`);
      assert.equal(response.status, 200);
      return stripComments(await response.text());
    }
  }
  throw new Error(`列表页应含条目「${title}」`);
}

function badgeOf(html) {
  const match = /<span class="genre-badge"[^>]*>([^<]*)<\/span>/.exec(html);
  return match ? match[1].trim() : null;
}

before(async () => {
  fixtures = createFixtureServer({ fixturesDir });
  const fixtureUrl = (await fixtures.start()).url;

  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      MAILER_OUTBOX_FILE: path.join(workDir, 'outbox.jsonl'),
      FIXTURES_DIR: fixturesDir,
      SOURCES_FIXTURE_BASE: fixtureUrl,
      SITE_URL: 'https://zw.test',
      ATTACHMENT_TEXT: 'off',
    },
  });

  // 真跑一轮抓取：判定必须在**入库路径**上算出来，脚本里补的不算（issue #76）
  const run = await runWorkerOnce();
  assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
  // 刻意不强删 workDir：Windows 上 SQLite 文件句柄释放有延迟，rmSync 会 EPERM ——
  // 既有 e2e 也都是只停服务（临时目录交给系统）。
});
describe('issue #76：详情页体裁角标', () => {
  it('修正案标题的条目，读者在正文前就看到「修正案」', async () => {
    assert.equal(badgeOf(await detailOf(AMENDMENT_TITLE)), '修正案');
  });

  it('新起草的规定标成「新案草案」，不被误标成修正案', async () => {
    assert.equal(badgeOf(await detailOf(NEW_DRAFT_TITLE)), '新案草案');
  });

  it('角标只有两类真判出来的才出现，未判定不占位置', async () => {
    const amendment = await detailOf(AMENDMENT_TITLE);
    assert.equal(/class="genre-badge"/.test(amendment), true);
    // 状态徽标与体裁徽标各是各的：状态回答"来不来得及"，体裁回答"该看什么"
    assert.match(amendment, /data-testid="notice-status-badge"/);
  });

  /**
   * issue #85 曾把「改动点」整块删掉（判据"它从未产出过"），而这个判据是错的 ——
   * 那 5 条候选从来没有被带那段代码的版本重跑过（86-*.md 第九节）。**这一段已于
   * issue #86 第 2 刀按实测重建**，所以这条用例**反过来**钉一件事：
   * **#85 之前落库的旧键形状，今天必须还能原样渲染出来。**
   *
   * 为什么值得单独钉：生产库里真有 5 行摘要带着这两个键（`changes` 数组 +
   * `changeMarkers` 计数），它们是 #81 重跑那批留下的历史形状。重建时改了字段语义
   * （引用池、类型白名单），读侧一旦不认旧形状，那 5 行就会从「有摘要」变成一栏空白 ——
   * 而**没有任何东西会提醒你**（#85 第三节那条"删/改功能要连读侧一起处理"）。
   * 注入而不是等生成：新摘要是不会自己长出这个夹具形状的（不注入就是测一条不存在的路径）。
   */
  it('#85 之前落库的旧键形状今天照常渲染（那 5 行历史摘要不许变成空白）', async () => {
    const db = new Database(dbFile);
    try {
      const original = db
        .prepare('select ai_summary_json as json from notices where title = ?')
        .get(AMENDMENT_TITLE)?.json;
      assert.ok(original, '前提：这条要有摘要，否则下面测的是"没有摘要"那条路');
      const withOldKeys = JSON.parse(original);
      withOldKeys.changes = [
        {
          clause: '第二条',
          kind: 'modify',
          text: '取得许可后方可从事',
          quote: '第二条修改为：从事前款活动应当取得许可。',
          source: '某某法（修正草案征求意见稿）.docx',
          sourceUrl: null,
        },
      ];
      withOldKeys.changeMarkers = { total: 3, byKind: { modify: 1, add: 1, delete: 1, renumber: 0 } };
      db.prepare('update notices set ai_summary_json = ? where title = ?').run(
        JSON.stringify(withOldKeys),
        AMENDMENT_TITLE,
      );
    } finally {
      db.close();
    }

    const html = await detailOf(AMENDMENT_TITLE);
    assert.match(html, /data-testid="ai-summary"/, '摘要卡片本身要在，排除"整页没渲染"这种假通过');
    assert.match(html, /data-testid="summary-changes"/, '这一段回来了：旧键要照常渲染');
    assert.match(html, /data-testid="summary-change-table"/);
    assert.ok(html.includes('改了哪几处'), '块标题');
    assert.ok(html.includes('第二条修改为：从事前款活动应当取得许可。'), '那一行的逐字原文');
    assert.ok(html.includes('出处：附件《某某法（修正草案征求意见稿）.docx》'), '出处照旧由程序算');
    assert.match(html, /data-testid="summary-change-coverage"/, '覆盖度那行要跟着旧计数一起渲染');
    assert.ok(html.includes('检测到 3 处'), '分母来自落库的 changeMarkers');
    assert.ok(html.includes('本页列出 1 处'), '列得比数到的少就照实说少');
  });

  /**
   * issue #79 的教训：**空壳比没有更坏**。一段"标题写着「改了哪几处」、内容却是空的"栏目，
   * 传达的不是"这次没改动"，而是"这一栏没东西可看" —— 后者不该占一个标题。
   * 所以判据是"一行都没有 ⇒ 整块不渲染"，而不是"计数为 0 就不渲染"。
   */
  it('一行改动都没有时整块不渲染（不是渲染成一张空表）', async () => {
    const db = new Database(dbFile);
    try {
      const original = db
        .prepare('select ai_summary_json as json from notices where title = ?')
        .get(AMENDMENT_TITLE)?.json;
      const cleared = JSON.parse(original);
      cleared.changes = [];
      cleared.changeMarkers = { total: 3, byKind: { modify: 1, add: 1, delete: 1, renumber: 0 } };
      db.prepare('update notices set ai_summary_json = ? where title = ?').run(
        JSON.stringify(cleared),
        AMENDMENT_TITLE,
      );
    } finally {
      db.close();
    }

    const html = await detailOf(AMENDMENT_TITLE);
    assert.match(html, /data-testid="ai-summary"/);
    assert.ok(!html.includes('data-testid="summary-changes"'), '一行都没有就不该有这一块');
    assert.ok(!html.includes('改了哪几处'), '连标题都不出现');
    assert.ok(
      !html.includes('本页列出 0 处'),
      '也不许用一句"列了 0 处"代替 —— 那是把"本站没读到"说成了一种结果',
    );
  });
});

/**
 * issue #86 第 1 刀：详情页的「可能的争议点」—— 全站唯一一段**推断**内容，以及它的受众面门控。
 *
 * 为什么这里**注入**而不是"跑一轮生成"：这一段要测的是**渲染与门控**（生成侧那条链在
 * `summary-genre-and-explanations.test.mjs` 里钉）。而且注入的那一条刻意带齐了类型、主体、
 * 推断与出处 —— 页面上"哪句是原文、哪句是本站的推断"必须一眼分得开，那正是这块内容的全部风险。
 *
 * 门控用的是两条**真实 fixture**（不是造的）：交通运输部那条判「公众广域」（法律修正草案），
 * 工信部那条判「行业专业」（无线电频率划分规定）—— 后者是用户拍板的"先不上"那一档。
 */
describe('issue #86：详情页「可能的争议点」与受众面门控', () => {
  const IMPACTS = [
    {
      quote: '收费公路在收费偿债或者收费经营期间的管理养护费用，在车辆通行费中列支。',
      who: '以车辆通行费筹集养护资金的地方政府',
      text: '期限届满后若继续收费，通行费负担可能长期化。',
      kind: 'risk',
      source: '关于《中华人民共和国公路法（修正草案征求意见稿）》的起草说明.wps',
      sourceUrl: 'https://attachments.test/explanation.wps',
    },
  ];

  function injectImpacts(title, impacts) {
    const db = new Database(dbFile);
    try {
      const original = db
        .prepare('select ai_summary_json as json from notices where title = ?')
        .get(title)?.json;
      assert.ok(original, `前提：${title} 要有摘要，否则下面测的是"没有摘要"那条路`);
      const summary = JSON.parse(original);
      summary.impacts = impacts;
      db.prepare('update notices set ai_summary_json = ? where title = ?').run(
        JSON.stringify(summary),
        title,
      );
    } finally {
      db.close();
    }
  }

  it('公众广域条目：推断渲染出来了，且带着块级免责声明、类型、主体与出处', async () => {
    injectImpacts(AMENDMENT_TITLE, IMPACTS);
    const html = await detailOf(AMENDMENT_TITLE);
    assert.match(html, /data-testid="ai-summary"/);
    assert.match(html, /data-testid="summary-impacts"/);
    assert.ok(html.includes('可能的争议点'), '块标题（用户 2026-09-27 选定的措辞）');
    assert.match(html, /data-testid="summary-impacts-note"/);
    assert.ok(html.includes('推断'), '块级免责声明必须写清"这是推断、不是官方表述"');
    assert.ok(html.includes('可能的不利后果'), '类型标签照 IMPACT_KIND_LABELS 渲染');
    assert.ok(html.includes('可能受影响：以车辆通行费筹集养护资金的地方政府'));
    assert.ok(html.includes('期限届满后若继续收费'), '推断的正文');
    assert.ok(html.includes('出处：附件《'), '出处是程序反查出来的那一份，不是模型自报的');
    assert.ok(
      html.includes('收费公路在收费偿债或者收费经营期间的管理养护费用'),
      '引用的逐字原文要与推断同屏 —— 绝不让推断脱离原文单独成立',
    );
  });

  it('行业专业条目：库里同样有判读，页面上一个字都不出现（受众面门控）', async () => {
    injectImpacts(NEW_DRAFT_TITLE, IMPACTS);
    const html = await detailOf(NEW_DRAFT_TITLE);
    assert.match(html, /data-testid="ai-summary"/, '摘要卡片本身要在，排除"整页没渲染"这种假通过');
    assert.ok(!html.includes('data-testid="summary-impacts"'), '这一档先不给读者看');
    assert.ok(!html.includes('可能的争议点'), '连标题都不出现');
    assert.ok(!html.includes('期限届满后若继续收费'), '推断的正文也不出现');
  });

  it('一条判读都没有时整块不渲染（连标题都不出现）', async () => {
    injectImpacts(AMENDMENT_TITLE, []);
    const html = await detailOf(AMENDMENT_TITLE);
    assert.match(html, /data-testid="ai-summary"/);
    assert.ok(!html.includes('data-testid="summary-impacts"'));
    assert.ok(!html.includes('可能的争议点'), '空壳比没有更坏 —— #85 的教训');
  });
});
