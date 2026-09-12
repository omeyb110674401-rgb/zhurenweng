import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { startAppServer } from './helpers/app-server.mjs';
import { createFixtureServer } from './helpers/fixture-server.mjs';

/**
 * E2E（issue #11）：数据统计页与出站点击聚合。
 *
 * 种子数据全部经既有端点构造（不直插数据库）：
 * - 入库：真实 worker 进程 WORKER_ONCE=1 抓取 fixtures/e2e-stats/ 三源快照
 *   （本目录为统计场景专用 fixture 根目录，发布 / 截止日期全部使用日期令牌：
 *   公示期差值恒定 30/15/7/45/30/15 天，发布月份恒落在最近 6 个月窗口内，
 *   断言不随运行日期衰减）；
 * - 点击：HTTP 调 /go/<id>，今天 3 次 + 进程时钟回拨 1 天后（node:test
 *   mock.timers 仅本用例窗口内替换 Date）再 3 次，构造跨日点击数据。
 *
 * 断言统计页 /stats：概览数字、各部门公示量、最近 6 个月趋势矩阵、
 * 公示期长度分布（≤7 / 8-15 / 16-30 / >30 天）、点击 Top 榜（链接回详情页）
 * 与按日期聚合；期望值全部由「已替换令牌的 fixture 快照」现场推导。
 * 另覆盖：抓取前空库空态渲染、列表页统计入口、重复抓取幂等不重算。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures', 'e2e-stats');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue11-'));
const dbFile = path.join(workDir, 'app.db');

/** 种子条目清单（title = 列表页标题，detailPath = fixture 快照地址）。 */
const ITEMS = {
  A: {
    title: '中华人民共和国慈善法（修正草案）征求意见',
    detailPath: '/npc/c2/c30834/t20260912_910001.html',
    source: 'npc',
  },
  B: {
    title: '中华人民共和国广播电视法（草案征求意见稿）征求意见',
    detailPath: '/npc/c2/c30834/t20260912_910002.html',
    source: 'npc',
  },
  C: {
    title: '司法部关于《中华人民共和国律师法（修订草案）》征求意见的通知',
    detailPath: '/moj/pub/sfbgw/zqyj/t20260912_920001.html',
    source: 'moj',
  },
  D: {
    title: '司法部关于《中华人民共和国非物质文化遗产法（修订草案）》公开征求意见的通知',
    detailPath: '/moj/pub/sfbgw/zqyj/t20260912_920002.html',
    source: 'moj',
  },
  E: {
    title: '国家发展改革委关于《中华人民共和国能源法（草案征求意见稿）》公开征求意见的通知',
    detailPath: '/govcn/zhengce/yjzj/202609/content_930001.html',
    source: 'govcn',
  },
  F: {
    title: '国家铁路局关于《地方铁路安全管理条例（修订草案征求意见稿）》公开征求意见的通知',
    detailPath: '/govcn/zhengce/yjzj/202609/content_930002.html',
    source: 'govcn',
  },
};

/** 点击计划：经 /go 端点的点击次数（今天 C/A/E 各 1；昨天 C×2、A×1）。 */
const CLICK_PLAN = { today: { C: 1, A: 1, E: 1 }, yesterday: { C: 2, A: 1 } };
const TOTAL_CLICKS =
  Object.values(CLICK_PLAN.today).reduce((sum, n) => sum + n, 0) +
  Object.values(CLICK_PLAN.yesterday).reduce((sum, n) => sum + n, 0);

let app;
let fixtures;
let fixtureUrl;
/** 点击日期（种子构造时记录，供按日聚合断言）：{ today, yesterday } */
let clickDates = {};

/** 单轮运行真实 worker 子进程（与其他场景同法：继承测试进程环境）。 */
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

function stripSsrComments(html) {
  return html.replaceAll('<!-- -->', '');
}

/** 本地日历日 ISO（与 src/lib/dates.ts 的 localDateIso 同口径）。 */
function localDateIso(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 最近 n 个日历月窗口（含当前月），月份升序 —— 与 /stats 页面同口径。 */
function lastMonthWindow(n, now) {
  const months = [];
  const cursor = new Date(now.getFullYear(), now.getMonth(), 1);
  for (let i = 0; i < n; i += 1) {
    months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`);
    cursor.setMonth(cursor.getMonth() - 1);
  }
  return months.reverse();
}

/** 两个 ISO 日期的日历天数差（b - a）。 */
function daysBetween(a, b) {
  const utc = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(b) - utc(a)) / (24 * 60 * 60 * 1000));
}

/** 公示期长度分桶（与 repo/stats.ts 同口径）。 */
function bucketOf(days) {
  if (days <= 7) return 'lte7';
  if (days <= 15) return 'b8_15';
  if (days <= 30) return 'b16_30';
  return 'gt30';
}

/** 中文 / ISO 日期文本 → ISO（YYYY-MM-DD）。 */
function normalizeDateText(text) {
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const cn = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(text);
  if (cn) return isoDate(Number(cn[1]), Number(cn[2]), Number(cn[3]));
  throw new Error(`无法解析日期文本：${text}`);
}

function isoDate(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

async function fetchFixtureText(fPath) {
  const response = await fetch(`${fixtureUrl}${fPath}`);
  assert.equal(response.status, 200, `fixture 快照应存在：${fPath}`);
  return response.text();
}

/** moj 详情页面包屑最后一级（过滤「首页」，与适配器同口径）。 */
function lastCrumb(html) {
  const crumbs = /<div class="crumbs">([\s\S]*?)<\/div>/.exec(html)[1];
  const texts = [...crumbs.matchAll(/<a[^>]*>([^<]+)<\/a>/g)]
    .map((match) => match[1].trim())
    .filter((text) => text.length > 0 && text !== '首页');
  return texts[texts.length - 1];
}

/**
 * 从「已替换日期令牌的 fixture 快照」推导统计期望值（种子数据的真值来源）。
 * 机关 / 日期解析方式与各源适配器同字段同口径（moj / govcn 机关取详情页，
 * npc 机关为适配器列表层兜底值 —— 快照特意不带「发布机关：」行）。
 */
let expectedCache = null;
async function expectedStats() {
  if (expectedCache) return expectedCache;

  const npcListHtml = await fetchFixtureText('/npc/list.html');
  const npcItems = [
    ...npcListHtml.matchAll(
      /<a href="([^"]+)" target="_blank">([^<]+)<\/a>\s*<span class="time">([^<]+)<\/span>/g,
    ),
  ].map((match) => ({ title: match[2], published: normalizeDateText(match[3]) }));

  const records = [];
  for (const [key, item] of Object.entries(ITEMS)) {
    const detailHtml = await fetchFixtureText(item.detailPath);
    let agency;
    let published;

    if (item.source === 'npc') {
      const listItem = npcItems.find((candidate) => item.title === candidate.title);
      assert.ok(listItem, `npc 列表应含条目「${item.title}」`);
      agency = '全国人大常委会法制工作委员会'; // 适配器列表层兜底机关（DEFAULT_AGENCY）
      published = listItem.published;
    } else if (item.source === 'moj') {
      agency = lastCrumb(detailHtml);
      published = normalizeDateText(/发布时间[:：]\s*([^\s<]+)/.exec(detailHtml)[1]);
    } else {
      agency = /<a class="dept-item"[^>]*>([^<]+)<\/a>/.exec(detailHtml)[1];
      published = normalizeDateText(
        /<span class="pub-date">发布日期：([^<]+)<\/span>/.exec(detailHtml)[1],
      );
    }

    const deadlineText =
      item.source === 'moj'
        ? /征求意见截止时间：<b>([^<]+)<\/b>/.exec(detailHtml)[1]
        : item.source === 'govcn'
          ? /<div class="deadline-value">([^<]+)<\/div>/.exec(detailHtml)[1]
          : /征求意见截止日期：([^\s<（]+)/.exec(detailHtml)[1];
    const deadline = normalizeDateText(deadlineText);

    const gap = daysBetween(published, deadline);
    records.push({
      key,
      title: item.title,
      detailPath: item.detailPath,
      agency,
      published,
      deadline,
      month: published.slice(0, 7),
      gap,
      bucket: bucketOf(gap),
    });
  }

  // 前置校验：fixture 设计保证所有发布月份都在最近 6 个月窗口内，
  // 月度趋势断言因此不随运行日期衰减（若失效会在这里给出明确报错）
  const window = lastMonthWindow(6, new Date());
  for (const record of records) {
    assert.ok(
      window.includes(record.month),
      `fixture 设计前置校验：${record.key} 的发布月份 ${record.month} 应在最近 6 个月窗口内`,
    );
  }

  const agencyTotals = new Map();
  const monthlyByAgency = new Map();
  const buckets = { lte7: 0, b8_15: 0, b16_30: 0, gt30: 0 };
  for (const record of records) {
    agencyTotals.set(record.agency, (agencyTotals.get(record.agency) ?? 0) + 1);
    if (!monthlyByAgency.has(record.agency)) monthlyByAgency.set(record.agency, new Map());
    const byMonth = monthlyByAgency.get(record.agency);
    byMonth.set(record.month, (byMonth.get(record.month) ?? 0) + 1);
    buckets[record.bucket] += 1;
  }

  expectedCache = { records, agencyTotals, monthlyByAgency, buckets, window };
  return expectedCache;
}

/** 从聚合列表页 HTML 提取 标题 → 详情条目 ID 映射。 */
async function noticeIdsByTitle() {
  const html = await (await fetch(`${app.url}/`)).text();
  const ids = new Map();
  for (const match of html.matchAll(
    /<a[^>]*notice-title-link[^>]*href="\/notices\/([0-9a-f]+)"[^>]*>([^<]+)<\/a>/g,
  )) {
    ids.set(match[2].trim(), match[1]);
  }
  return ids;
}

/** 解析 /stats 概览数字。 */
function parseOverview(html) {
  return {
    totalNotices: Number(/data-testid="stats-total-notices">(\d+)</.exec(html)[1]),
    totalClicks: Number(/data-testid="stats-total-clicks">(\d+)</.exec(html)[1]),
  };
}

/** 解析各部门公示量表行（→ [{ agency, count }]）。 */
function parseAgencyTotals(html) {
  return [
    ...html.matchAll(
      /data-testid="agency-total-row">\s*<th scope="row">([^<]+)<\/th>\s*<td class="stat-num">(\d+)<\/td>/g,
    ),
  ].map((match) => ({ agency: match[1], count: Number(match[2]) }));
}

/** 解析月度趋势矩阵行（→ [{ agency, cells: [6 个月计数], total }]）。 */
function parseTrendRows(html) {
  return [...html.matchAll(/data-testid="trend-row">([\s\S]*?)<\/tr>/g)].map((match) => {
    const block = match[1];
    const agency = /<th scope="row">([^<]+)<\/th>/.exec(block)[1];
    const cells = [...block.matchAll(/<td class="stat-num" data-month="[^"]*">(\d+)<\/td>/g)].map(
      (cell) => Number(cell[1]),
    );
    const total = Number(/<td class="stat-num stat-total">(\d+)<\/td>/.exec(block)[1]);
    return { agency, cells, total };
  });
}

/** 解析月度趋势「全部机关」合计行（→ { monthTotals: [6], grand }）。 */
function parseTrendTotals(html) {
  const block = /data-testid="trend-total-row">([\s\S]*?)<\/tr>/.exec(html)[1];
  const cells = [...block.matchAll(/<td class="stat-num stat-total">(\d+)<\/td>/g)].map((cell) =>
    Number(cell[1]),
  );
  return { monthTotals: cells.slice(0, 6), grand: cells[cells.length - 1] };
}

/** 解析公示期分布行（→ { bucketKey: count }）。 */
function parsePeriodBuckets(html) {
  const result = {};
  for (const match of html.matchAll(
    /data-bucket="([^"]+)"[\s\S]*?<span class="period-count">(\d+) 条<\/span>/g,
  )) {
    result[match[1]] = Number(match[2]);
  }
  return result;
}

/** 解析点击 Top 榜行（→ [{ id, title, agency, clicks }]，按展示顺序）。 */
function parseTopClicks(html) {
  return [...html.matchAll(/data-testid="top-click-row">([\s\S]*?)<\/li>/g)].map((match) => {
    const block = match[1];
    const meta = /class="top-click-meta">(.+?) · (\d+) 次</.exec(block);
    return {
      id: /href="\/notices\/([0-9a-f]+)"/.exec(block)[1],
      title: /data-testid="top-click-link"[^>]*>([^<]+)<\/a>/.exec(block)[1],
      agency: meta[1],
      clicks: Number(meta[2]),
    };
  });
}

/** 解析按日期聚合行（→ { date: clicks }）。 */
function parseClicksByDate(html) {
  const result = {};
  for (const match of html.matchAll(
    /data-testid="click-date-row" data-date="([^"]+)">[^<]*<strong>(\d+)<\/strong>/g,
  )) {
    result[match[1]] = Number(match[2]);
  }
  return result;
}

before(async () => {
  fixtures = createFixtureServer({ fixturesDir });
  fixtureUrl = (await fixtures.start()).url;

  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      MAILER_OUTBOX_FILE: path.join(workDir, 'outbox.jsonl'),
      FIXTURES_DIR: fixturesDir,
      // 关键注入：全部源适配器的列表页指向本地 fixture 源站（e2e-stats 根目录）
      SOURCES_FIXTURE_BASE: fixtureUrl,
    },
  });
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('issue #11：数据统计页与出站点击聚合', () => {
  it('抓取前：统计页渲染空态（空库不报错）', async () => {
    const response = await fetch(`${app.url}/stats`);
    assert.equal(response.status, 200);
    const html = stripSsrComments(await response.text());

    assert.deepEqual(parseOverview(html), { totalNotices: 0, totalClicks: 0 });
    assert.match(html, /data-testid="stats-agency-empty"/, '部门公示量空态');
    assert.match(html, /data-testid="stats-trend-empty"/, '月度趋势空态');
    assert.match(html, /data-testid="stats-period-empty"/, '公示期分布空态');
    assert.match(html, /data-testid="stats-top-clicks-empty"/, '点击 Top 榜空态');
    assert.match(html, /data-testid="stats-clicks-by-date-empty"/, '按日期聚合空态');
    assert.match(html, /← 返回公示列表/, '面包屑返回列表');
    assert.match(html, /不记录任何个人身份/, '隐私说明');
  });

  it('worker 单轮抓取：统计场景三源共 6 条入库', async () => {
    const first = await runWorkerOnce();
    assert.equal(first.code, 0, `worker 应正常退出，输出：${first.output}`);
    assert.match(first.output, /源 npc 抓取完成：列表 2 条，新增 2，更新 0/);
    assert.match(first.output, /源 moj 抓取完成：列表 2 条，新增 2，更新 0/);
    assert.match(first.output, /源 govcn 抓取完成：列表 2 条，新增 2，更新 0/);
  });

  it('列表页头部含「数据统计」入口链接', async () => {
    const html = await (await fetch(`${app.url}/`)).text();
    const anchor = /<a[^>]*data-testid="stats-nav-link"[^>]*>/.exec(html);
    assert.ok(anchor, '列表页头部应有统计入口');
    assert.match(anchor[0], /href="\/stats"/, '入口应指向 /stats');
  });

  it('种子点击（全部经 /go 端点）：今天 3 次 + 昨天回拨时钟 3 次，302 且无 Cookie', async (t) => {
    const ids = await noticeIdsByTitle();
    const idOf = Object.fromEntries(
      Object.entries(ITEMS).map(([key, item]) => [key, ids.get(item.title)]),
    );
    for (const [key, id] of Object.entries(idOf)) {
      assert.ok(id, `列表页应能定位条目 ${key}（${ITEMS[key].title}）的详情 ID`);
    }

    // 今天（真实时钟）：C / A / E 各 1 次；首次点击顺带断言 302 目标 = 官方原文
    // （不额外发起点击，避免污染按条目 / 按日计数）
    let isFirstClick = true;
    const clickOnce = async (key) => {
      const response = await fetch(`${app.url}/go/${idOf[key]}`, { redirect: 'manual' });
      assert.equal(response.status, 302, `点击 ${key} 应 302`);
      assert.equal(response.headers.get('set-cookie'), null, '不记录任何个人身份（无 Cookie）');
      if (isFirstClick) {
        isFirstClick = false;
        assert.equal(
          response.headers.get('location'),
          `${fixtureUrl}${ITEMS[key].detailPath}`,
          `302 目标应为 ${key} 的官方原文 URL`,
        );
      }
    };

    for (const [key, times] of Object.entries(CLICK_PLAN.today)) {
      for (let i = 0; i < times; i += 1) await clickOnce(key);
    }
    const today = localDateIso(new Date());

    // 昨天：仅在回拨后的窗口内调 /go（node:test mock.timers 替换 Date，
    // 让应用侧 localDateIso(new Date()) 落到昨天，构造跨日点击数据）。
    // 注意：enable 后 Date.now() 即走 mock 时钟（起点 0），目标时刻须先算好。
    const yesterdayMs = Date.now() - 24 * 60 * 60 * 1000;
    t.mock.timers.enable({ apis: ['Date'] });
    try {
      t.mock.timers.setTime(yesterdayMs);
      for (const [key, times] of Object.entries(CLICK_PLAN.yesterday)) {
        for (let i = 0; i < times; i += 1) await clickOnce(key);
      }
    } finally {
      t.mock.timers.reset();
    }
    const yesterday = localDateIso(new Date(Date.now() - 24 * 60 * 60 * 1000));

    assert.notEqual(today, yesterday, '今天与昨天应是不同日历日');
    clickDates = { today, yesterday };
  });

  it('统计页：概览与各部门公示量聚合正确', async () => {
    const expected = await expectedStats();
    const html = stripSsrComments(await (await fetch(`${app.url}/stats`)).text());

    assert.deepEqual(
      parseOverview(html),
      { totalNotices: expected.records.length, totalClicks: TOTAL_CLICKS },
      '概览：收录条目数与累计出站提意点击（北极星指标总量）',
    );

    const rows = parseAgencyTotals(html);
    assert.deepEqual(
      new Map(rows.map((row) => [row.agency, row.count])),
      expected.agencyTotals,
      '机关 → 公示量 聚合应与种子数据一致',
    );
    // 排序：条目数最多（且唯一最大）的机关排第一
    const maxCount = Math.max(...expected.agencyTotals.values());
    const topAgencies = [...expected.agencyTotals.entries()].filter(([, n]) => n === maxCount);
    assert.equal(topAgencies.length, 1, 'fixture 设计：最大公示量的机关应唯一');
    assert.equal(rows[0].agency, topAgencies[0][0]);
    assert.equal(rows[0].count, maxCount);
  });

  it('统计页：公示量月度趋势矩阵正确（最近 6 个月 × 机关）', async () => {
    const expected = await expectedStats();
    const html = stripSsrComments(await (await fetch(`${app.url}/stats`)).text());

    const rows = parseTrendRows(html);
    assert.deepEqual(
      new Map(rows.map((row) => [row.agency, row])),
      new Map(
        [...expected.monthlyByAgency.entries()].map(([agency, byMonth]) => [
          agency,
          {
            agency,
            cells: expected.window.map((month) => byMonth.get(month) ?? 0),
            total: [...byMonth.values()].reduce((sum, n) => sum + n, 0),
          },
        ]),
      ),
      '趋势矩阵：机关 × 最近 6 个月计数应与种子数据一致（窗口外月份为 0）',
    );
    for (const row of rows) {
      assert.equal(
        row.cells.reduce((sum, n) => sum + n, 0),
        row.total,
        `机关「${row.agency}」行小计 = 6 个月之和`,
      );
    }

    // 「全部机关」合计行 = 各机关逐月求和
    const totals = parseTrendTotals(html);
    const monthTotals = expected.window.map((_, index) =>
      rows.reduce((sum, row) => sum + row.cells[index], 0),
    );
    assert.deepEqual(totals.monthTotals, monthTotals);
    assert.equal(totals.grand, expected.records.length);
  });

  it('统计页：公示期长度分布分桶正确（≤7 / 8-15 / 16-30 / >30 天）', async () => {
    const expected = await expectedStats();
    const html = stripSsrComments(await (await fetch(`${app.url}/stats`)).text());

    const parsed = parsePeriodBuckets(html);
    assert.deepEqual(parsed, expected.buckets);
    assert.equal(
      Object.values(parsed).reduce((sum, n) => sum + n, 0),
      expected.records.length,
      '四个分布桶之和 = 参与统计的条目总数',
    );
  });

  it('统计页：出站点击 Top 榜链接回详情页，按日期聚合正确', async () => {
    const expected = await expectedStats();
    const ids = await noticeIdsByTitle();
    const html = stripSsrComments(await (await fetch(`${app.url}/stats`)).text());

    // Top 榜：C(3) > A(2) > E(1)，按点击数降序；标题与详情 ID 对应种子条目
    const clicksOf = (key) => (CLICK_PLAN.today[key] ?? 0) + (CLICK_PLAN.yesterday[key] ?? 0);
    const expectedTop = expected.records
      .map((record) => ({ key: record.key, record }))
      .filter(({ key }) => clicksOf(key) > 0)
      .sort((a, b) => clicksOf(b.key) - clicksOf(a.key) || a.key.localeCompare(b.key))
      .map(({ record }) => ({
        id: ids.get(record.title),
        title: record.title,
        agency: record.agency,
        clicks: clicksOf(record.key),
      }));
    const topRows = parseTopClicks(html);
    assert.deepEqual(topRows, expectedTop, 'Top 榜应按点击数降序且机关 / 回链正确');
    assert.equal(topRows.length, 3, '只有被点击过的条目进榜');
    for (const row of topRows) {
      assert.ok(row.id, `Top 榜条目「${row.title}」应有详情页回链`);
    }

    // 按日期聚合：昨天 3 次、今天 3 次，各一行
    const perDateTotal = (date) =>
      Object.keys(CLICK_PLAN).reduce(
        (sum, day) =>
          sum +
          (clickDates[day] === date
            ? Object.values(CLICK_PLAN[day]).reduce((s, n) => s + n, 0)
            : 0),
        0,
      );
    const byDate = parseClicksByDate(html);
    assert.deepEqual(
      byDate,
      {
        [clickDates.yesterday]: perDateTotal(clickDates.yesterday),
        [clickDates.today]: perDateTotal(clickDates.today),
      },
      `按日期聚合应为 ${clickDates.yesterday}=${perDateTotal(clickDates.yesterday)}、${clickDates.today}=${perDateTotal(clickDates.today)}`,
    );
    assert.equal(
      Object.values(byDate).reduce((sum, n) => sum + n, 0),
      TOTAL_CLICKS,
      '按日聚合总和 = 全部点击数',
    );
  });

  it('重复抓取幂等：统计页数字与点击聚合不变', async () => {
    const second = await runWorkerOnce();
    assert.equal(second.code, 0, `worker 应正常退出，输出：${second.output}`);
    assert.match(second.output, /源 npc 抓取完成：列表 2 条，新增 0，更新 2/);
    assert.match(second.output, /源 moj 抓取完成：列表 2 条，新增 0，更新 2/);
    assert.match(second.output, /源 govcn 抓取完成：列表 2 条，新增 0，更新 2/);

    const expected = await expectedStats();
    const html = stripSsrComments(await (await fetch(`${app.url}/stats`)).text());
    assert.deepEqual(parseOverview(html), {
      totalNotices: expected.records.length,
      totalClicks: TOTAL_CLICKS,
    });
    assert.deepEqual(
      new Map(parseAgencyTotals(html).map((row) => [row.agency, row.count])),
      expected.agencyTotals,
    );
    assert.equal(parseTopClicks(html).length, 3, '重复抓取不得清零或重算点击聚合');
  });
});
