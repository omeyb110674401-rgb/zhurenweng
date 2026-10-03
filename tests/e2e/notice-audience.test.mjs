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
 * E2E（issue #83）：受众面 —— 分类要**读者看得见、筛得动**，而且必须是真跑一轮抓取之后的。
 *
 * 为什么值得开一条 e2e：受众面是"入库时按标题判一次"的派生列（`notices.audience`），
 * 中间要过三跳：入库判定 → 落库 → 列表筛选 / 详情角标。单测只能证明纯函数对；
 * #68/#70 的教训正是链条中间断一环、两端各自都"看起来正常"。
 *
 * fixture 三源（npc / moj / mee）的形状正好覆盖两大类，判据来自 lib/audience.ts：
 * - npc 三条法案（企业破产法 / 道路交通安全法 / 检察公益诉讼法）：源就是全国人大 ⇒ 公众广域；
 * - 金融法（草案）与 moj 两条**条例**（行政复议法实施条例 / 行政法规制定程序条例）：
 *   标题是法律、条例草案 ⇒ 公众广域（注意行政复议那条里含"行政复议"，靠"立法优先于行业"这条顺序才对）；
 * - mee 三条**标准 / 导则 / 名录**（饮用水源数据元技术规范 / 近岸海域名录 / 核动力厂导则）：
 *   给专业技术人员执行的文件 ⇒ 行业专业。
 *
 * 另外钉住两件容易写错的事：
 * 1. `?audience=unknown` **要连 NULL 一起收**（本列上线前的存量在运营口径里也是"没归类"）；
 * 2. 未知取值不生效（不能因为手改 URL 就筛出一页空的）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-audience-'));
const dbFile = path.join(workDir, 'app.db');

const PUBLIC_TITLES = [
  '企业破产法（修订草案二次审议稿）征求意见',
  '道路交通安全法（修订草案）征求意见',
  '检察公益诉讼法（草案二次审议稿）征求意见',
  '司法部、中国人民银行、金融监管总局、中国证监会、国家外汇局关于《中华人民共和国金融法（草案）》公开征求意见的通知',
  '司法部关于《中华人民共和国行政复议法实施条例（修订征求意见稿）》公开征求意见的通知',
  '司法部关于《行政法规制定程序条例（修订征求意见稿）》公开征求意见的通知',
];

const SECTOR_TITLES = [
  '关于公开征求《饮用水水源地基础信息数据元技术规范（征求意见稿）》等2项国家生态环境标准意见的通知',
  '关于公开征求《沿海省（区、市）近岸海域重要物种名录》意见的函',
  '关于公开征求国家生态环境标准《生态环境影响评价技术导则 核动力厂（征求意见稿）》（修订HJ808-2016）意见的通知',
];

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

function itemTitle(item) {
  const match = /data-testid="notice-title-link"[^>]*>([^<]*)<\/a>/.exec(item);
  return match ? match[1] : '';
}

/** 结果页 HTML → 条目标题集合（受受众面筛选后的那批）。 */
function listTitles(html) {
  return noticeItems(html).map(itemTitle);
}

async function fetchHome(query = '') {
  const response = await fetch(`${app.url}/${query}`);
  assert.equal(response.status, 200, `首页应 200，实际 ${response.status}（query=${query}）`);
  return stripComments(await response.text());
}

/** 按标题找到详情页链接并取回其 HTML。 */
async function detailOf(title) {
  const list = await fetchHome('');
  for (const block of noticeItems(list)) {
    if (itemTitle(block) !== title) continue;
    const href = /href="(\/notices\/[0-9a-f]+)"/.exec(block)?.[1];
    assert.ok(href, `条目块应含详情页链接：${title}`);
    return stripComments(await (await fetch(`${app.url}${href}`)).text());
  }
  throw new Error(`列表页应含条目「${title}」`);
}

before(async () => {
  fixtures = createFixtureServer({ fixturesDir });
  const fixtureUrl = (await fixtures.start()).url;

  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      SOURCES_FIXTURE_BASE: fixtureUrl,
    },
  });

  const run = await runWorkerOnce();
  assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('issue #83：受众面分类与筛选', () => {
  it('入库时按标题判定并落库：公众广域 6 条、行业专业 3 条、未判定 0 条', async () => {
    const db = new Database(dbFile, { readonly: true });
    const rows = db
      .prepare('select title, audience, audience_basis as basis from notices')
      .all();
    db.close();
    const byTitle = new Map(rows.map((row) => [row.title, row]));

    for (const title of PUBLIC_TITLES) {
      assert.equal(byTitle.get(title)?.audience, 'public', `「${title}」应为公众广域`);
    }
    for (const title of SECTOR_TITLES) {
      assert.equal(byTitle.get(title)?.audience, 'sector', `「${title}」应为行业专业`);
    }
    // 判定必须带得出依据：一个说不出凭什么判的字段，使用者既不敢信也没法改
    for (const row of rows) {
      assert.ok((row.basis ?? '').length > 0, `「${row.title}」缺判定依据`);
    }
  });

  it('筛选条渲染两组：受众面（全部 + 三档）与领域标签云', async () => {
    const html = await fetchHome('');
    assert.match(html, /data-testid="audience-filter"[^>]*aria-label="按受众面筛选"/);
    assert.match(html, /data-testid="audience-filter-all"[^>]*>全部</);
    const chips = [...html.matchAll(/data-testid="audience-filter-link"[^>]*data-audience="([^"]+)"/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(chips, ['public', 'sector', 'unknown'], '三档筛选值（未判定也在，用来找没归类的）');
    assert.match(html, /data-testid="audience-filter-link"[^>]*>公众广域/);
    assert.match(html, /data-testid="audience-filter-link"[^>]*>行业专业/);
    assert.match(html, /data-testid="audience-filter-link"[^>]*>未判定/);
    // 两排筛选是两件事，各自有自己的地标名
    assert.match(html, /data-testid="category-filter"[^>]*aria-label="按领域筛选"/);
  });

  it('按受众面筛选：公众广域 6 条、行业专业 3 条，且计数文案带口径', async () => {
    const publicHtml = await fetchHome('/?audience=public');
    assert.deepEqual(listTitles(publicHtml).sort(), [...PUBLIC_TITLES].sort());
    assert.match(publicHtml, /data-testid="filter-result-count"[^>]*>筛选后共 6 条/);
    // 这行文字是「筛选后共 N 条」里 N 的口径说明，少一个维度读者只能猜这个数是谁造成的
    assert.match(publicHtml, /受众面：公众广域/);
    assert.match(publicHtml, /data-testid="audience-filter-link"[^>]*data-audience="public"[^>]*aria-current="true"/);

    const sectorHtml = await fetchHome('/?audience=sector');
    assert.deepEqual(listTitles(sectorHtml).sort(), [...SECTOR_TITLES].sort());
    assert.match(sectorHtml, /data-testid="filter-result-count"[^>]*>筛选后共 3 条/);
    assert.match(sectorHtml, /受众面：行业专业/);

    // 两类的并集 = 全量（fixture 里没有未判定的条目）
    const full = listTitles(await fetchHome(''));
    assert.equal(full.length, PUBLIC_TITLES.length + SECTOR_TITLES.length);
  });

  it('受众面与领域是两个正交维度：可叠加，且各自保留在表单里', async () => {
    // 领域「生态环境」的 3 条全是行业专业 ⇒ 与受众面叠加后条数不变
    const both = await fetchHome(
      `/?audience=sector&category=${encodeURIComponent('生态环境')}`,
    );
    assert.deepEqual(listTitles(both).sort(), [...SECTOR_TITLES].sort());
    assert.match(both, /<input type="hidden" name="audience" value="sector"/);
    assert.match(both, /<input type="hidden" name="category" value="生态环境"/);

    // 叠加一个对不上的组合：公众广域 × 生态环境 = 空态（不是"忘了筛受众面"）
    const none = await fetchHome(`/?audience=public&category=${encodeURIComponent('生态环境')}`);
    assert.match(none, /data-testid="notice-empty-state"/);
  });

  it('未知取值不生效（手改 URL 不该筛出一页空的）', async () => {
    const full = listTitles(await fetchHome('')).length;
    for (const bad of ['both', 'PUBLIC', 'all', '']) {
      const html = await fetchHome(`/?audience=${bad}`);
      assert.equal(listTitles(html).length, full, `audience=${bad} 应等同不筛`);
      assert.ok(!html.includes('受众面：'), `audience=${bad} 不该出现在口径说明里`);
    }
  });

  it('详情页角标：读者在正文前看到自己属于哪一类，判据挂在 title 上可核对', async () => {
    const publicDetail = await detailOf(PUBLIC_TITLES[1]);
    const publicBadge = /<span class="audience-badge audience-public"[^>]*data-audience="public"[^>]*>([^<]*)</.exec(
      publicDetail,
    );
    assert.ok(publicBadge, '公众广域的条目应有受众面角标');
    assert.equal(publicBadge[1].trim(), '公众广域');
    assert.match(publicDetail, /title="[^"]*立法|title="[^"]*草案/, '凭什么这么判要能悬停看到');

    const sectorDetail = await detailOf(SECTOR_TITLES[0]);
    const sectorBadge = /<span class="audience-badge audience-sector"[^>]*data-audience="sector"[^>]*>([^<]*)</.exec(
      sectorDetail,
    );
    assert.ok(sectorBadge, '行业专业的条目应有受众面角标');
    assert.equal(sectorBadge[1].trim(), '行业专业');
    // 三个角标各答一个问题：状态（来不来得及）/ 体裁（是哪种文件）/ 受众面（找谁的意见）
    assert.match(sectorDetail, /data-testid="notice-status-badge"/);
  });

  it('「只订这一批」与 RSS 都带上受众面（筛选条件不许在订阅路径上丢失）', async () => {
    const html = await fetchHome('/?audience=sector');
    // 先取整个 <a> 标签再找 href：JSX 的属性顺序（className / href / data-testid）会
    // 原样出现在 HTML 里，把两个属性写死在一条正则里迟早会因为顺序调整而失效
    const subFeedTag = /<a[^>]*data-testid="filtered-rss-link"[^>]*>/.exec(html)?.[0];
    const subFeed = subFeedTag === undefined ? undefined : /href="([^"]+)"/.exec(subFeedTag)?.[1];
    assert.ok(subFeed, '筛选生效时应给出「只订这一批」入口');
    assert.match(subFeed.replaceAll('&amp;', '&'), /audience=sector/);

    const feed = await (await fetch(`${app.url}/feed.xml?audience=sector`)).text();
    // feed 的条目标题是 XML 转义后的原文（`escapeXml`），这些标题里没有需要转义的字符
    for (const title of SECTOR_TITLES) {
      assert.ok(feed.includes(title), `行业专业的「${title.slice(0, 20)}…」应在这份子 feed 里`);
    }
    for (const title of PUBLIC_TITLES) {
      assert.ok(
        !feed.includes(title),
        `公众广域的「${title.slice(0, 20)}…」不该出现在行业专业的子 feed 里`,
      );
    }
  });

  it('未判定筛选连 NULL（本列上线前的存量）一起收 —— 否则筛选器对着空分类说话', async () => {
    // fixture 里每条都判得出来，所以「未判定」此刻应当是空的
    const before = await fetchHome('/?audience=unknown');
    assert.match(before, /data-testid="filter-result-count"[^>]*>筛选后共 0 条/);

    // 手工把一条退回 NULL，模拟"本列上线前入库的存量行"
    const db = new Database(dbFile);
    db.prepare('update notices set audience = null where title = ?').run(SECTOR_TITLES[0]);
    db.close();

    const after_ = await fetchHome('/?audience=unknown');
    assert.deepEqual(listTitles(after_), [SECTOR_TITLES[0]], 'NULL 的存量行应出现在「未判定」下');
    assert.match(after_, /data-testid="filter-result-count"[^>]*>筛选后共 1 条/);

    // 反向：它不该再出现在原类别里（NULL 不是"还留在行业专业"）
    const sector = await fetchHome('/?audience=sector');
    assert.ok(!listTitles(sector).includes(SECTOR_TITLES[0]));
  });
});

/**
 * issue #87（2026-10-03 用户拍板「标记只放首页」）：列表页的「这条里有什么」。
 *
 * 为什么这一组放在**受众面**这个文件里：这一刀的全部风险就是**门控同源**。
 * 生产库里有一批 `sector` 条目存着判读、而详情页一个字都不渲染；列表页若照库里的
 * 数组打标记，读者点进去会发现什么都没有。所以判据必须经由 `shouldRenderImpacts`
 * （单测把这条契约定死了），这里钉的是**它真的到了首页 HTML 上**。
 *
 * 判据本身钉不住在 e2e 里（撤 `src/lib/**` 撤不出红，e2e 跑的是构建产物）——
 * 这一组的价值在"接线"：组件真的把那行字画出来了。
 */
describe('issue #87：列表标记与受众面门控同源', () => {
  it('公众广域 ⇒ 两个标记都在；行业专业 ⇒ 判读标记不许有、改动对照照样有（两个标记门控不同）', async () => {
    // 直接注入一份**已知**的摘要（不依赖 stub 产出什么），这样断言才是确定的。
    // 注意 `what` / `deadline` / `howToComment` 这三段是 `parseQuotedSummary` 的**必需段**
    // （`summary-content.ts` 里 `if (!what || !deadline || !howToComment) return null`）——
    // 少了它们整份解析成 null，标记会静默不打（第一次就踩在这里：判据没错、夹具不对）。
    const injected = JSON.stringify({
      what: { text: '关于某规定的征求意见稿。', quote: null },
      deadline: { text: '2026-10-24', quote: null },
      howToComment: { text: '可通过电子邮件提交意见。', quote: null },
      impacts: [
        {
          quote: '收费公路在收费偿债或者收费经营期间的管理养护费用，在车辆通行费中列支。',
          who: '高速公路通行车主',
          point: '通行费用支出',
          text: '期限届满后可能继续收费。',
          kind: 'burden',
          source: null,
          sourceUrl: null,
        },
      ],
      // 一条**完整**的改动行：`quote` 与 `text` 缺一即被读侧丢掉（与判读同一条不变量），
      // 所以夹具必须给全，否则"改动对照打标"那条断言会红在一个与判据无关的地方。
      changes: [
        {
          clause: '第三十六条',
          kind: 'modify',
          text: '改为依法征税筹集公路管理养护资金。',
          quote: '将第三十六条修改为：“国家采用依法征税的办法筹集公路管理养护资金”。',
          source: null,
          sourceUrl: null,
        },
      ],
      changeTable: { entries: [], headers: 0 },
    });
    const db = new Database(dbFile);
    db.prepare('update notices set ai_summary_json = ? where title = ?').run(injected, PUBLIC_TITLES[0]);
    db.prepare('update notices set ai_summary_json = ? where title = ?').run(injected, SECTOR_TITLES[0]);
    db.close();

    const html = await fetchHome('');
    const blockOf = (title) => {
      const block = noticeItems(html).find((item) => itemTitle(item) === title);
      assert.ok(block, `首页应含条目「${title}」`);
      return block;
    };

    const publicBlock = blockOf(PUBLIC_TITLES[0]);
    assert.match(
      publicBlock,
      /data-testid="notice-mark"[^>]*data-mark="impacts"[^>]*>含本站推断（非官方）</,
      '公众广域 + 有判读 ⇒ 列表要标出「含本站推断（非官方）」',
    );
    assert.match(
      publicBlock,
      /title="本站 AI 依据公开原文作出的推断/,
      '完整说明要挂在 title 上（悬停与读屏都拿得到，列表不因此变长）',
    );
    assert.match(publicBlock, /data-testid="notice-mark"[^>]*data-mark="changes"|data-mark="changes"/, '改动对照也打标');

    const sectorBlock = blockOf(SECTOR_TITLES[0]);
    /*
     * 两个标记的**门控不一样**，这一条断言把这件事钉死：
     * - 「含本站推断」跟着 `shouldRenderImpacts` 走 ⇒ 行业专业档**不许**打
     *   （详情页那一段对 sector 不渲染，列表打了就是在承诺不存在的东西）；
     * - 「含改动对照」**不受受众面门控**（详情页「改了哪几处」对任何受众面都渲染，
     *   它是事实、不是推断）⇒ 这里**应当**有。
     * 第一版我断言的是"整个 sector 块一个标记都没有" —— 那是错的，而且错得很有价值：
     * 它说明"两个标记同门控"是个很容易想当然的假设。
     */
    assert.ok(
      !/data-mark="impacts"/.test(sectorBlock),
      '行业专业条目详情页不渲染判读 —— 列表就不许打「含本站推断」（那是在承诺详情页不存在的东西）',
    );
    assert.match(
      sectorBlock,
      /data-mark="changes"/,
      '改动对照不受受众面门控：详情页那一段对任何受众面都渲染',
    );
  });
});
