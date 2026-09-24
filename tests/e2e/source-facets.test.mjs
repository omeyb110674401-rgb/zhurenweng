import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { siteDateIso } from '../../src/lib/dates.ts';
import { startAppServer } from './helpers/app-server.mjs';
import { cellNumber, noticeItems, stripSsrComments } from './helpers/html.mjs';

/**
 * 端到端 + 仓储层（issue #65）：`?source=` 筛选与统计页「各来源收录量」。
 *
 * 这一刀要钉住的是一整类"看板说没事、其实没数据"的问题：源健康（issue #58）只看
 * 「这一轮抓取有没有报错」，于是**一个源可以天天成功、连续几周一条新的都不送**
 * （源站改版、栏目换址、选择器失效）。能揭穿它的是 `first_seen_at`（#60 第 3 刀加的列），
 * 而那张表必须同时满足 issue #36 的不变式：**点进去的条数 = 表格上的数字**。
 * 所以这里既走真实 HTTP 数条目，也直调仓储函数（撤 SQL 实现时后者会红，前者不会 ——
 * `check-test-pins.mjs` 的规则 1）。
 *
 * 四个源各管一件事：
 * - 甲源：3 条（2 条未截止）—— 常规行；
 * - 乙源：2 条，其中一条**库里还写 open 但截止日已过** —— 「未截止」那一格要按展示口径算；
 * - 丙源：登记了但**一条都没收到** —— 必须出现在表上（那正是故障本身），不能因为 0 被挤掉；
 * - 幽灵源：条目挂着它、登记表里没有（#58 清掉的 `govcn` 那类死行）—— 照列并标注，
 *   否则「各行之和 = 总数」这条对不上而没人发现（issue #46 的同一件事）。
 *
 * 零外部依赖（ADR-0001）：临时 SQLite + stub LLM / 邮件。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-issue65-'));
const dbFile = path.join(workDir, 'app.db');

const SRC_A = { id: 'src-a', name: '甲源（测试）' };
const SRC_B = { id: 'src-b', name: '乙源（测试）' };
const SRC_C = { id: 'src-c', name: '丙源（零收录）' };
const GHOST = 'ghost-source';

/** 条目：[id, 标题, 源, 截止日偏移, 库里状态, 首次收录偏移] */
const NOTICES = [
  ['1'.repeat(32), '来源甲之一：未截止', SRC_A.id, 20, 'open', -2],
  ['2'.repeat(32), '来源甲之二：未截止', SRC_A.id, 5, 'open', -20],
  ['3'.repeat(32), '来源甲之三：已截止', SRC_A.id, -5, 'closed', -40],
  ['4'.repeat(32), '来源乙之一：库里未改口的过期条目', SRC_B.id, -1, 'open', -3],
  ['5'.repeat(32), '来源乙之二：未截止', SRC_B.id, 9, 'open', -30],
  ['6'.repeat(32), '幽灵源条目：登记表里没有这个源', GHOST, 3, 'open', -7],
];

let app;
let noticesRepo;

/**
 * 播种时刻固定一次：断言「最近新收录」要拿**同一个**时间戳比对，
 * 否则 before() 与断言之间隔了几百毫秒，精确相等的断言会因为时钟而不是因为代码失败。
 */
const SEED_NOW = new Date();

function stampPlusDays(days) {
  return new Date(SEED_NOW.getTime() + days * 86_400_000).toISOString();
}

function datePlusDays(days) {
  return stampPlusDays(days).slice(0, 10);
}

async function pageHtml(query = '') {
  const response = await fetch(`${app.url}/${query}`, { cache: 'no-store' });
  assert.equal(response.status, 200);
  return stripSsrComments(await response.text());
}

/** 首页渲染出的条目数（与「共 N 条」比对用）。 */
const itemCount = (html) => noticeItems(html).length;

/**
 * 表格行里的两个数字格（收录量 / 未截止）。
 *
 * 走 `cellNumber`（先剥标签）而不是锚 `data-testid`：数字为 0 时 `DrillNumber` 刻意退化成
 * 纯文本（点进去必然是空页），那两种写法都要能读出 0，否则测试会把"正确行为"读成"缺字段"。
 */
function rowCounts(rowHtml) {
  const cells = [...rowHtml.matchAll(/<td class="stat-num">([\s\S]*?)<\/td>/g)].map((match) => match[1]);
  assert.equal(cells.length, 2, `行里应有两个数字格：${rowHtml.slice(0, 200)}`);
  return { count: cellNumber(cells[0]), openCount: cellNumber(cells[1]) };
}

before(async () => {
  process.env.DB_DRIVER = 'sqlite';
  process.env.DATABASE_URL = dbFile;
  process.env.LLM_PROVIDER = 'stub';
  process.env.MAILER_PROVIDER = 'stub';
  process.env.SITE_URL = 'https://zw.test';
  process.env.APP_BASE_URL = 'https://zw.test';
  process.env.ATTACHMENT_TEXT = 'off';

  noticesRepo = await import('../../src/db/repo/notices.ts');
  const sourcesRepo = await import('../../src/db/repo/sources.ts');
  for (const source of [SRC_A, SRC_B, SRC_C, { id: GHOST, name: '已注销的幽灵源' }]) {
    await sourcesRepo.registerSource({ ...source, adapterType: 'fixture' });
  }
  for (const [id, title, sourceId, deadlinePlusDays, status, seenPlusDays] of NOTICES) {
    await noticesRepo.upsertNotice({
      id,
      sourceId,
      title,
      agency: '测试机关',
      url: `https://source.test/${id}.html`,
      publishedAt: datePlusDays(-10),
      deadlineAt: datePlusDays(deadlinePlusDays),
      status,
      bodyText: '现向社会公开征求意见。',
      attachments: [],
      fetchedAt: stampPlusDays(seenPlusDays),
    });
  }

  // 复刻 #58 清 `govcn` 死行后的现场：SQLite 侧 notices.source_id 带外键（PG 侧没有），
  // 所以只能先登记、入库，再**关掉外键**把登记行删掉 —— 条目留着、源没了。
  // 不这么做就测不到 `registered: false` 那一支，而它恰恰是生产里真出现过的形状。
  const raw = new Database(dbFile);
  raw.pragma('foreign_keys = OFF');
  raw.prepare('DELETE FROM sources WHERE id = ?').run(GHOST);
  raw.close();

  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      SITE_URL: 'https://zw.test',
      APP_BASE_URL: 'https://zw.test',
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      ATTACHMENT_TEXT: 'off',
    },
  });
});

after(async () => {
  await app?.stop();
  // 临时库文件留给系统清：Windows 上连接释放前 rmSync 会 EPERM
});

describe('issue #65 仓储层：来源聚合', () => {
  it('登记了但零收录的源也在结果里（那正是要看得见的情形）', async () => {
    const facets = await noticesRepo.listNoticeSourceFacets();
    const byId = new Map(facets.map((facet) => [facet.id, facet]));
    assert.ok(byId.has(SRC_C.id), '丙源一条都没收到 —— 不能因此从表上消失');
    assert.equal(byId.get(SRC_C.id).count, 0);
    assert.equal(byId.get(SRC_C.id).lastFirstSeenAt, null);
    assert.equal(byId.get(SRC_C.id).registered, true);
    // 名字来自登记表（表上显示的是「丙源（零收录）」而不是 ID）
    assert.equal(byId.get(SRC_C.id).name, SRC_C.name);
    assert.equal(byId.get(SRC_A.id).name, SRC_A.name);
  });

  it('未截止那一格按展示口径算（与 `?open=1` 同一份判据）', async () => {
    const facets = await noticesRepo.listNoticeSourceFacets();
    const byId = new Map(facets.map((facet) => [facet.id, facet]));
    assert.equal(byId.get(SRC_A.id).count, 3);
    assert.equal(byId.get(SRC_A.id).openCount, 2, '甲源三条里已截止的那条不算未截止');
    // 乙源两条库里都是 open，其中一条截止日已过 → 未截止只有 1
    assert.equal(byId.get(SRC_B.id).count, 2);
    assert.equal(byId.get(SRC_B.id).openCount, 1, '库里还写 open 但过期了的那条不算未截止');
  });

  it('条目引用了登记表外的源时如实标注，名字退回 ID（不静默归并）', async () => {
    const facet = (await noticesRepo.listNoticeSourceFacets()).find((row) => row.id === GHOST);
    assert.ok(facet, '幽灵源的条目不能凭空消失');
    assert.equal(facet.registered, false);
    assert.equal(facet.name, GHOST);
  });

  it('各行之和 = 条目总数（表与页面「收录 N 条」不许分家）', async () => {
    const facets = await noticesRepo.listNoticeSourceFacets();
    const total = facets.reduce((sum, facet) => sum + facet.count, 0);
    assert.equal(total, NOTICES.length);
    assert.equal(await noticesRepo.countNoticesFiltered({}), NOTICES.length);
  });

  it('「最近新收录」取该源最新的首次收录时间（甲源 -2 天，不是 -40 天那条）', async () => {
    const facets = await noticesRepo.listNoticeSourceFacets();
    const byId = new Map(facets.map((facet) => [facet.id, facet]));
    assert.equal(byId.get(SRC_A.id).lastFirstSeenAt, stampPlusDays(-2));
    assert.equal(byId.get(SRC_B.id).lastFirstSeenAt, stampPlusDays(-3));
    assert.equal(byId.get(GHOST).lastFirstSeenAt, stampPlusDays(-7));
  });

  it('sourceId 筛选精确命中，且与其余维度可叠加', async () => {
    assert.equal((await noticesRepo.listNoticesFiltered({ sourceId: SRC_A.id })).length, 3);
    assert.equal((await noticesRepo.listNoticesFiltered({ sourceId: SRC_B.id, openOnly: true })).length, 1);
    assert.equal((await noticesRepo.listNoticesFiltered({ sourceId: 'no-such-source' })).length, 0);
    const [rows, count] = await Promise.all([
      noticesRepo.listNoticesFiltered({ sourceId: SRC_A.id, category: '不存在的领域' }),
      noticesRepo.countNoticesFiltered({ sourceId: SRC_A.id, category: '不存在的领域' }),
    ]);
    assert.equal(count, rows.length, '计数与列表同口径');
  });
});

describe('issue #65 统计页：表上的数字点得开', () => {
  let stats;
  let rows;

  before(async () => {
    stats = stripSsrComments(await (await fetch(`${app.url}/stats`, { cache: 'no-store' })).text());
    rows = [...stats.matchAll(/<tr[^>]*data-testid="source-facet-row"[^>]*data-source="([^"]*)"[\s\S]*?<\/tr>/g)].map(
      (match) => ({ id: match[1], html: match[0] }),
    );
  });

  it('四个来源都在表上（含零收录的丙源与登记表外的幽灵源）', () => {
    const ids = rows.map((row) => row.id);
    assert.deepEqual(ids.sort(), [SRC_A.id, SRC_B.id, SRC_C.id, GHOST].sort());
    assert.match(stats, /丙源（零收录）/);
    assert.match(stats, /未在源登记表/, '幽灵源要标出来，不能被静默归并');
    assert.match(stats, /data-testid="source-no-new">暂无新收录/);
  });

  it('「最近新收录」显示的是站点日历日，不是原始 UTC 时间戳', () => {
    const rowA = rows.find((row) => row.id === SRC_A.id);
    const cell = /<td>([^<]*)<\/td>\s*<\/tr>/.exec(rowA.html)?.[1] ?? '';
    assert.match(cell, /^\d{4}-\d{2}-\d{2}$/, `应是 YYYY-MM-DD，实际「${cell}」`);
    assert.equal(cell, siteDateIso(new Date(stampPlusDays(-2))));
    assert.ok(!cell.includes('T'), '不该把 ISO 时间戳原样贴在表上');
  });

  it('每一格的条数 = 点进去那一页真实渲染的条数（issue #36 的不变式）', async () => {
    for (const row of rows) {
      const { count, openCount } = rowCounts(row.html);
      const pageOf = await pageHtml(`?source=${encodeURIComponent(row.id)}`);
      const openPage = await pageHtml(`?source=${encodeURIComponent(row.id)}&open=1`);
      assert.equal(itemCount(pageOf), count, `${row.id} 的收录量格子与页面不符`);
      assert.equal(itemCount(openPage), openCount, `${row.id} 的未截止格子与页面不符`);
      assert.match(pageOf, new RegExp(`共 ${count} 条|筛选后共 ${count} 条`));
    }
  });

  it('表格各行之和等于页首的收录总数', () => {
    const sum = rows.reduce((total, row) => total + rowCounts(row.html).count, 0);
    assert.equal(sum, Number(/data-testid="stats-total-notices">(\d+)</.exec(stats)[1]));
  });

  it('差额提示只在真有未登记源时出现，并点名它是谁', () => {
    assert.match(stats, /data-testid="stats-source-unregistered"/);
    assert.match(stats, /1 行的来源已不在源登记表里/);
  });
});

describe('issue #65 首页：来源下拉与筛选', () => {
  it('下拉列出登记表里的源（含零收录的）并带条数', async () => {
    const html = await pageHtml();
    assert.match(html, /data-testid="source-filter-select"/);
    assert.match(html, /<option value="src-a">甲源（测试）（3）<\/option>/);
    assert.match(html, /<option value="src-c">丙源（零收录）（暂无收录）<\/option>/,
      '零收录的源也要能选 —— 那正是"这个源不再送东西了"的入口');
  });

  it('选中来源后筛选摘要写出的是名字而不是 ID', async () => {
    const html = await pageHtml(`?source=${SRC_A.id}&open=1`);
    assert.match(html, /筛选后共 2 条（来源：甲源（测试） · 只看未截止）/);
    assert.ok(!html.includes('来源：src-a'), '给人读的那行不该露 ID');
    assert.equal(itemCount(html), 2);
  });

  it('当前值不在选项里时补成选项并回显（issue #39：下拉不许显示「全部来源」而列表其实筛过了）', async () => {
    const html = await pageHtml('?source=vanished-source');
    const select = /<select[^>]*source-filter-select[\s\S]*?<\/select>/.exec(html)?.[0] ?? '';
    assert.ok(select.length > 0, '来源下拉应在场');
    assert.match(
      select,
      /<option value="vanished-source"[^>]*selected[^>]*>vanished-source（暂无收录）<\/option>/,
      '当前值必须是选项之一，且处于选中态（否则下拉在说谎）',
    );
    assert.ok(
      !/<option value=""[^>]*selected/.test(select),
      '「全部来源」不该是选中态 —— 列表其实已经按那个源筛过了',
    );
    assert.match(html, /筛选后共 0 条（来源：vanished-source）/);
  });

  it('来源与其它维度、排序、翻页可共存（换维度不丢条件）', async () => {
    const html = await pageHtml(`?source=${SRC_A.id}&sort=clicks`);
    const hrefs = [...html.matchAll(/data-testid="sort-link"[^>]*href="([^"]*)"|href="([^"]*)"[^>]*data-testid="sort-link"/g)]
      .map((match) => match[1] ?? match[2]);
    assert.ok(hrefs.length >= 4);
    for (const href of hrefs.map((h) => h.replaceAll('&amp;', '&'))) {
      assert.ok(href.includes('source=src-a'), `排序链接应带上来源：${href}`);
    }
  });

  it('子 feed 带来源条件，且条目集合与首页相同', async () => {
    const query = `?source=${SRC_B.id}`;
    const response = await fetch(`${app.url}/feed.xml${query}`, { cache: 'no-store' });
    const xml = await response.text();
    assert.match(xml, new RegExp(`<title>[^<]*—— 来源：乙源（测试）</title>`));
    assert.match(xml, /<atom:link href="https:\/\/zw\.test\/feed\.xml\?source=src-b"/);
    const feedIds = [...xml.matchAll(/<guid[^>]*>([^<]*)<\/guid>/g)].map((match) => match[1]);
    const homeIds = [...noticeItems(await pageHtml(query))].map(
      (block) => /\/notices\/([0-9a-f]+)/.exec(block)?.[1] ?? '',
    );
    assert.deepEqual([...feedIds].sort(), [...homeIds].sort());
  });
});
