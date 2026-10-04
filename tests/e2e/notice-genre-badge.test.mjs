import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { impactReviewRecordsFrom, serializeImpactReviews } from '../../src/lib/impact-review.ts';
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
    assert.ok(html.includes('按改动字眼数到 3 处'), '分母来自落库的 changeMarkers（它是字眼计数）');
    assert.ok(html.includes('本页列出 1 处'), '列得比数到的少就照实说少');
  });

  /**
   * issue #86 第二十节第 3 小节：**行由程序定**的那张表怎么渲染。
   *
   * 为什么这一条非有不可：这一版改动把"哪些行"从模型手里拿走（`changeTable`），
   * 而页面的判据在 `.tsx` 里 —— 钉不住（`check-test-pins.mjs` 的第 1 条硬规则：e2e 跑的是
   * `.next` 构建产物，改 `src/app/**` 对它无效，撤了也不红）。所以这一条用**注入**把
   * 三种行同屏摆出来：有说明的、只报事实的、以及不单独成行的标题。
   *
   * 注入的 `changeMarkers.total` 刻意**大于**行数（4 处 / 3 行）：读者看到的必须是
   * "检测到 4 处表述"与"归并成 3 行"两个数并列，而不是把 4 说成 3。
   */
  it('有表就按表的行序渲染：只报事实的行也在，标题句不在，措辞换成"按句归并"', async () => {
    const FACT_HEAD = '将“交通主管部门”统一修改为“交通运输主管部门”，将“贫困地区”修改为“欠发达地区”。';
    const FACT_DELETE = '删去第七条第二款。';
    const DESCRIBED_QUOTE = '第二条修改为：从事前款活动应当取得许可。';
    const db = new Database(dbFile);
    try {
      const original = db
        .prepare('select ai_summary_json as json from notices where title = ?')
        .get(AMENDMENT_TITLE)?.json;
      assert.ok(original, '前提：这条要有摘要');
      const withTable = JSON.parse(original);
      withTable.changes = [
        {
          clause: '第二条',
          kind: 'modify',
          text: '取得许可后方可从事',
          quote: DESCRIBED_QUOTE,
          source: '某某法（修正草案征求意见稿）.docx',
          sourceUrl: null,
        },
      ];
      withTable.changeMarkers = { total: 4, byKind: { modify: 2, add: 1, delete: 1, renumber: 0 } };
      withTable.changeTable = {
        entries: [
          { type: 'fact', clause: '', kinds: ['modify'], sentence: FACT_HEAD },
          { type: 'described', change: 0 },
          { type: 'fact', clause: '第七条', kinds: ['delete'], sentence: FACT_DELETE },
        ],
        headers: 1,
      };
      db.prepare('update notices set ai_summary_json = ? where title = ?').run(
        JSON.stringify(withTable),
        AMENDMENT_TITLE,
      );
    } finally {
      db.close();
    }

    const html = await detailOf(AMENDMENT_TITLE);
    assert.match(html, /data-testid="summary-change-table"/);
    assert.equal(
      html.split('data-testid="summary-change-row-fact"').length - 1,
      2,
      '两行只有事实：检测到表述、但模型没写出可核对的说明',
    );
    assert.equal(html.split('data-testid="summary-change-row-described"').length - 1, 1);
    assert.ok(html.includes('本站在这一句里数到了「删除」'), '照实说数到了哪个字眼');
    assert.ok(html.includes('，但没能给出可核对的说明'), '并说清没能给出说明');
    assert.ok(
      !html.includes('检测到这一处改动表述'),
      '旧措辞把"匹配到字眼"说成了"这里有一处改动"，不许回来',
    );
    assert.ok(html.includes(FACT_HEAD), '只报事实的行要把那一句原文印出来给读者自己看');
    assert.ok(html.includes(FACT_DELETE));
    assert.ok(
      !html.includes('对部分条文作以下修改：</td>') && !html.includes('下面的子条目不单独成行'),
      '标题句不单独成行（headers 那一句只在交代里出现）',
    );
    // 行序 = 表里的行序（程序定的），不是模型给出的顺序
    const atHead = html.indexOf(FACT_HEAD);
    const atDescribed = html.indexOf(DESCRIBED_QUOTE);
    const atDelete = html.indexOf(FACT_DELETE);
    assert.ok(atHead < atDescribed && atDescribed < atDelete, '按表里的行序渲染');
    assert.match(html, /data-testid="summary-change-coverage"/);
    assert.ok(html.includes('这类字眼数到 4 处'), '分母照旧来自落库的 changeMarkers（字眼计数）');
    assert.ok(html.includes('按句归并成 3 行'), '表由程序定，所以说得清"归并成几行"');
    assert.ok(html.includes('2 行只报「这一句里数到了改动字眼」这一事实'), '几行缺说明要说出来');
    assert.ok(html.includes('另有 1 句是小标题'), '不单独成行的标题句也要交代');
    assert.ok(!html.includes('本页列出'), '旧措辞（"列出几处"）不许再出现 —— 那一版表会少行');
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
      // 表也要清掉：留着它，页面就会按"行由程序定"渲染出上面那条用例注入的行
      delete cleared.changeTable;
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
describe('issue #86 / #52：详情页「可能的争议点」与渲染门（只看审读记录）', () => {
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

  /**
   * 注入判读，并**默认同时注入与它匹配的审读记录**。
   *
   * 为什么要一起注入（#52）：门是 fail-closed 的 —— 只有"有有效审读记录"的判读才渲染。
   * 只注入摘要的话，这一组测的就变成"没有记录 ⇒ 什么都不渲染"，而不是页面上那几行字。
   * 反过来，`withRecords: false` 正是"没有记录"那一档的夹具。
   */
  function injectImpacts(title, impacts, options = {}) {
    const { withRecords = true } = options;
    const db = new Database(dbFile);
    try {
      const original = db
        .prepare('select ai_summary_json as json from notices where title = ?')
        .get(title)?.json;
      assert.ok(original, `前提：${title} 要有摘要，否则下面测的是"没有摘要"那条路`);
      const summary = JSON.parse(original);
      summary.impacts = impacts;
      // 记录按**写侧**造出来：指纹口径只有一处，夹具不手抄
      const records = withRecords
        ? serializeImpactReviews(
            impactReviewRecordsFrom({
              impacts,
              verdicts: impacts.map((impact) => ({
                quote: impact.quote,
                text: impact.text,
                status: 'passed',
              })),
              model: 'e2e',
              reviewedAt: '2026-10-04T00:00:00.000Z',
            }),
          )
        : null;
      db.prepare(
        'update notices set ai_summary_json = ?, impact_review_json = ? where title = ?',
      ).run(JSON.stringify(summary), records, title);
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
    // 2026-10-02 第二刀：这一行从「可能受影响：<主体>」改成「影响：<主体> · <方面>」。
    // 这条 fixture **没有 point**（存量 39 条判读的真实形状）⇒ 只渲染 who 那半句，
    // 也就是下面这一行 —— 顺带钉住"旧行没有 point 也照常渲染"这条读侧容错。
    assert.ok(
      html.includes('影响：以车辆通行费筹集养护资金的地方政府'),
      '第二刀的行文案：who 与 point 用「 · 」连接，只有 who 时只显示 who',
    );
    assert.ok(
      !html.includes('可能受影响：'),
      '旧措辞不许再出现（它与新行同时存在时，读者会以为是两件事）',
    );
    assert.match(html, /data-testid="summary-impacts-overview"/);
    assert.ok(
      html.includes('共 1 处：1 处可能的不利后果'),
      '概览的计数行：N 是判读条数（这一条 fixture 只有 1 条 risk 判读）',
    );
    assert.ok(html.includes('期限届满后若继续收费'), '推断的正文');
    assert.ok(html.includes('出处：附件《'), '出处是程序反查出来的那一份，不是模型自报的');
    assert.ok(
      html.includes('收费公路在收费偿债或者收费经营期间的管理养护费用'),
      '引用的逐字原文要与推断同屏 —— 绝不让推断脱离原文单独成立',
    );
  });

  /**
   * 2026-10-02 第二刀：**块首概览**（用户要的第 2 件）。
   *
   * 为什么这一条要单独注入两条不同 kind 的判读：概览行的两个数（`共 N 处` 与各类型的条数）
   * 只有**多类型混排**时才看得出顺序对不对（固定 risk → loophole → burden → other，
   * 而 88 号文档 7.5 给的那一行例子恰好是 loophole 在前）。单类型时"顺序"这个词没有内容。
   *
   * 这一行是**程序聚合**的（不额外调模型），所以页面上看到的就是判据算出来的 ——
   * 单测钉措辞（`tests/unit/impact-overview.test.mjs`），这里钉"它真的到了页面上"。
   */
  it('块首概览：计数按类型聚合、主体去重，且每条判读自己的行带上「方面」', async () => {
    injectImpacts(AMENDMENT_TITLE, [
      IMPACTS[0],
      {
        quote: '网络服务提供者应当建立便捷的投诉、举报入口，及时受理并处理公众投诉、举报。',
        who: '不愿实名发言的用户',
        point: '匿名发声空间',
        text: '实名要求可能压缩匿名表达的空间。',
        kind: 'loophole',
        source: '关于《中华人民共和国公路法（修正草案征求意见稿）》的起草说明.wps',
        sourceUrl: 'https://attachments.test/explanation.wps',
      },
    ]);
    const html = await detailOf(AMENDMENT_TITLE);
    assert.match(html, /data-testid="summary-impacts-overview"/);
    assert.ok(
      html.includes('共 2 处：1 处可能的不利后果 · 1 处可能被规避或滥用'),
      '概览的计数行：N 是判读条数，类型顺序固定 risk → loophole → burden → other',
    );
    assert.match(html, /data-testid="summary-impacts-overview-who"/);
    assert.ok(
      html.includes('影响：以车辆通行费筹集养护资金的地方政府、不愿实名发言的用户'),
      '主体行：去重后按首次出现顺序、用「、」连接',
    );
    assert.ok(
      html.includes('影响：不愿实名发言的用户 · 匿名发声空间'),
      '每条判读自己那一行：who 与 point 用「 · 」连接（这一条带 point）',
    );
  });

  it('行业专业条目：**有审读记录就渲染**（#52：受众面已退出判据）；没有记录才一个字都不出现', async () => {
    // 这一条是 flip 前后语义变化最大的地方：从前行业档一律不渲染（受众面门控），
    // 现在门只认审读记录 —— 而那正是"带门扩"要的效果。
    injectImpacts(NEW_DRAFT_TITLE, IMPACTS);
    const rendered = await detailOf(NEW_DRAFT_TITLE);
    assert.match(rendered, /data-testid="ai-summary"/, '摘要卡片本身要在');
    assert.match(
      rendered,
      /data-testid="summary-impacts"/,
      '行业专业 + 有效审读记录 ⇒ 渲染（受众面不再是判据）',
    );
    assert.ok(rendered.includes('可能的争议点'));

    injectImpacts(NEW_DRAFT_TITLE, IMPACTS, { withRecords: false });
    const blocked = await detailOf(NEW_DRAFT_TITLE);
    assert.match(blocked, /data-testid="ai-summary"/, '排除"整页没渲染"这种假通过');
    assert.ok(
      !blocked.includes('data-testid="summary-impacts"'),
      '没有审读记录 ⇒ 不渲染（fail-closed）',
    );
    assert.ok(!blocked.includes('可能的争议点'), '连标题都不出现');
    assert.ok(!blocked.includes('期限届满后若继续收费'), '推断的正文也不出现');
  });

  it('一条判读都没有时整块不渲染（连标题都不出现）', async () => {
    injectImpacts(AMENDMENT_TITLE, []);
    const html = await detailOf(AMENDMENT_TITLE);
    assert.match(html, /data-testid="ai-summary"/);
    assert.ok(!html.includes('data-testid="summary-impacts"'));
    assert.ok(!html.includes('可能的争议点'), '空壳比没有更坏 —— #85 的教训');
  });
});
