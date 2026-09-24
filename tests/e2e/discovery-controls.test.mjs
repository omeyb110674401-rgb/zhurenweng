import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { startAppServer } from './helpers/app-server.mjs';
import { noticeItems, robotsMeta, stripSsrComments } from './helpers/html.mjs';

/**
 * 端到端（issue #62）：发现层的排序与筛选。
 *
 * 这一刀要钉的是**「页面上说的顺序 / 范围」与「实际渲染出来的条目」必须一致**。
 * 这类判断此前只活在 SQL 里，出错的表现恰好是最难发现的那种：页面照常渲染、
 * 文案照常说「按最新收录排序」，实际顺序却是别的字段算的；或者「只看未截止」
 * 放进来一条徽标写着「已截止」的条目（筛选器与徽标各说一套）。所以断言全部走
 * **真实构建产物的 HTTP 响应**，而不是直接调仓储函数。
 *
 * 五条夹具条目各管一件事：
 * - 甲：新收录（2 天前）、晚截止（+30 天）、3 次点击
 * - 乙：最新发布（-35 天）、+2 天截止、0 次点击
 * - 丙：库里已 closed、50 次点击
 * - 丁：**库里还写 open，但截止日已过（-1 天）** —— 「只看未截止」必须按展示口径排掉它
 *   （issue #43 的同一件事：抓取每日一轮，刚过截止的条目在库里仍是 open）
 * - 戊：`first_seen_at` 为 NULL 的存量行 —— 任何「最近新增」都不该把它算进来
 *
 * 零外部依赖（ADR-0001）：临时 SQLite + stub LLM / 邮件。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-issue62-'));
const dbFile = path.join(workDir, 'app.db');

const A = { id: 'a'.repeat(32), title: '发现层甲：新收录晚截止', agency: '测试甲机关', clicks: 3 };
const B = { id: 'b'.repeat(32), title: '发现层乙：最新发布', agency: '测试乙机关', clicks: 0 };
const C = { id: 'c'.repeat(32), title: '发现层丙：已截止高点击', agency: '测试甲机关', clicks: 50 };
const D = { id: 'd'.repeat(32), title: '发现层丁：库里未改口的过期条目', agency: '测试乙机关', clicks: 0 };
const E = { id: 'e'.repeat(32), title: '发现层戊：存量无收录时间', agency: '测试甲机关', clicks: 9 };
const ALL = [A, B, C, D, E];
const BY_TITLE = new Map(ALL.map((notice) => [notice.title, notice]));

let app;
let noticesRepo;

/** 距今 N 天的时间戳（负数 = 过去）；`first_seen_at` / `fetched_at` 用它。 */
function stampPlusDays(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** 距今 N 天的日期（YYYY-MM-DD）；发布 / 截止日期用它。 */
function datePlusDays(days) {
  return stampPlusDays(days).slice(0, 10);
}

/** 页面渲染出的条目标题（按展示顺序）。 */
function titles(html) {
  return noticeItems(html)
    .map((block) => block.slice(0, block.indexOf('</li>')))
    .map((block) => (/<a[^>]*notice-title-link[^>]*>([^<]+)<\/a>/.exec(block) ?? [])[1] ?? '');
}

/** 页面顺序 → 条目清单（比对排序时比读标题省事；出现未知条目当场失败）。 */
function order(html) {
  return titles(html).map((title) => {
    const notice = BY_TITLE.get(title);
    assert.ok(notice, `页面上出现了本场景之外的条目：${title}`);
    return notice;
  });
}

/** 断言页面顺序（写成 `[D, B, A, E, C]` 这种形状，读的人不用查字母表）。 */
function assertOrder(html, expected, message) {
  assert.deepEqual(
    order(html).map((notice) => notice.id),
    expected.map((notice) => notice.id),
    `${message ?? '页面顺序'}：实际 ${order(html).map((n) => n.title[3]).join('')}`,
  );
}

/** 带「新」角标的条目（按展示顺序）。 */
function badged(html) {
  return noticeItems(html)
    .filter((block) => block.includes('notice-new-badge'))
    .map((block) => BY_TITLE.get((/<a[^>]*notice-title-link[^>]*>([^<]+)<\/a>/.exec(block) ?? [])[1]));
}

async function page(query = '') {
  const response = await fetch(`${app.url}/${query}`, { cache: 'no-store' });
  assert.equal(response.status, 200, `首页 ${query || '(无参数)'} 应返回 200`);
  return stripSsrComments(await response.text());
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
  await sourcesRepo.registerSource({
    id: 'e2e-discovery',
    name: '发现层测试源',
    adapterType: 'fixture',
  });

  // upsertNotice 建行时把 first_seen_at 写成 fetchedAt，此后更新不覆盖 ——
  // 所以「什么时候被收录」由 fetchedAt 控制，正是线上那条链的真实形状。
  const seed = async (notice, { publishedPlusDays, deadlinePlusDays, seenPlusDays, status }) => {
    await noticesRepo.upsertNotice({
      id: notice.id,
      sourceId: 'e2e-discovery',
      title: notice.title,
      agency: notice.agency,
      url: `https://source.test/${notice.id}.html`,
      publishedAt: datePlusDays(publishedPlusDays),
      deadlineAt: datePlusDays(deadlinePlusDays),
      status,
      bodyText: '现向社会公开征求意见。',
      attachments: [],
      fetchedAt: stampPlusDays(seenPlusDays),
    });
  };
  await seed(A, { publishedPlusDays: -200, deadlinePlusDays: 30, seenPlusDays: -2, status: 'open' });
  await seed(B, { publishedPlusDays: -35, deadlinePlusDays: 2, seenPlusDays: -20, status: 'open' });
  await seed(C, { publishedPlusDays: -80, deadlinePlusDays: -10, seenPlusDays: -40, status: 'closed' });
  await seed(D, { publishedPlusDays: -110, deadlinePlusDays: -1, seenPlusDays: -5, status: 'open' });
  await seed(E, { publishedPlusDays: -190, deadlinePlusDays: 60, seenPlusDays: -100, status: 'open' });

  const db = new Database(dbFile);
  for (const notice of ALL) {
    db.prepare('UPDATE notices SET outbound_clicks = ? WHERE id = ?').run(notice.clicks, notice.id);
  }
  // 戊：存量行的 first_seen_at 置 NULL（迁移 0013 之前入库、还没被重抓到的那种）
  db.prepare('UPDATE notices SET first_seen_at = NULL WHERE id = ?').run(E.id);
  db.close();

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
  // 临时库文件留给系统清：Windows 上 SQLite 连接释放前 rmSync 会 EPERM
});

describe('issue #62：排序档位真实生效', () => {
  it('不带参数 = 原倒计时序（未截止优先 → 截止升序），既有首页行为一字不差', async () => {
    // 未截止优先：丁(-1) 乙(+2) 甲(+30) 戊(+60) 在前，已截止的丙沉底
    assertOrder(await page(), [D, B, A, E, C], '默认档');
  });

  it('`?sort=deadline` 与不带参数完全相同（默认档位没有偷偷换实现）', async () => {
    assert.deepEqual(titles(await page('?sort=deadline')), titles(await page()));
  });

  it('`?sort=published` 按发布日期倒序（不看状态，已截止的也按发布日期排）', async () => {
    // 发布：乙(-35) > 丙(-80) > 丁(-110) > 戊(-190) > 甲(-200)
    assertOrder(await page('?sort=published'), [B, C, D, E, A], '发布档');
  });

  it('`?sort=newest` 按 first_seen_at（不是每天覆盖的 fetched_at），无收录时间的存量沉底', async () => {
    // 收录：甲(-2) > 丁(-5) > 乙(-20) > 丙(-40) > 戊(NULL)
    assertOrder(await page('?sort=newest'), [A, D, B, C, E], '收录档');
  });

  it('`?sort=clicks` 并列时按倒计时兜底，不是「同分随机序」', async () => {
    // 点击：丙(50) > 戊(9) > 甲(3) > 丁 / 乙(0)；同为 0 时按倒计时 → 丁(-1) 在乙(+2) 前
    assertOrder(await page('?sort=clicks'), [C, E, A, D, B], '点击档');
  });

  it('未知排序值不生效（回落默认档，而不是报错或空页）', async () => {
    for (const value of ['title', 'Deadline', 'DROP%20TABLE']) {
      assert.deepEqual(titles(await page(`?sort=${value}`)), titles(await page()), `sort=${value}`);
    }
  });

  it('同一地址请求两次顺序一致（排序是全序；#54 的页边界事故由此排除）', async () => {
    assert.equal(titles(await page('?sort=clicks')).join('|'), titles(await page('?sort=clicks')).join('|'));
  });
});

describe('issue #62：`?open=1` 只看未截止', () => {
  it('排除库里已 closed 的，也排除「库里还写 open 但截止日已过」的（按展示口径）', async () => {
    const html = await page('?open=1');
    assertOrder(html, [B, A, E], '未截止视图');
    assert.ok(!html.includes(C.title), '已截止的丙不该出现');
    assert.ok(!html.includes(D.title), '丁在库里仍是 open，但截止日已过 —— 不该出现');
  });

  it('筛选摘要写明「只看未截止」，条数与实际渲染的条目数一致', async () => {
    const html = await page('?open=1');
    assert.match(html, /筛选后共 3 条（只看未截止）/);
    assert.equal(titles(html).length, 3);
  });

  it('与机关筛选可叠加，且这一页里没有任何「已截止」徽标', async () => {
    const html = await page('?open=1&agency=测试甲机关');
    assertOrder(html, [A, E], '机关 + 未截止');
    assert.match(html, /筛选后共 2 条（机关：测试甲机关 · 只看未截止）/);
    for (const block of noticeItems(html)) {
      assert.ok(!/status-closed/.test(block), '未截止视图里不该有已截止徽标');
    }
  });

  it('不带 open 时丁照样在列表里（它只是库里还没改口，不是数据错了）', async () => {
    assert.ok((await page()).includes(D.title));
  });
});

describe('issue #62：`?since=N` 最近新增', () => {
  it('只留最近 N 天收录的；`first_seen_at` 为 NULL 的存量不进来', async () => {
    assertOrder(await page('?since=7'), [D, A], '近 7 天');
    assertOrder(await page('?since=30'), [D, B, A], '近 30 天');
  });

  it('近 30 天含乙（20 天前收录），不含丙（40 天）与戊（NULL）', async () => {
    const html = await page('?since=30');
    for (const notice of [A, B, D]) {
      assert.ok(html.includes(notice.title), `${notice.title} 应在近 30 天里`);
    }
    for (const notice of [C, E]) {
      assert.ok(!html.includes(notice.title), `${notice.title} 不该在近 30 天里`);
    }
    assert.match(html, /筛选后共 3 条（最近 30 天收录）/);
  });

  it('超出上限的值**不生效**而不是夹到 90（夹窄了会少给条目，读者看不出来）', async () => {
    for (const value of ['91', '99999']) {
      const html = await page(`?since=${value}`);
      assert.equal(titles(html).length, 5, `since=${value} 超过上限 → 不筛选，给全部`);
      assert.ok(!/筛选后共/.test(html), '不生效就不该出现筛选文案');
    }
  });

  it('「新」角标固定 7 天窗口，不跟筛选走（否则人人带角标，标记就不传递信息了）', async () => {
    // 比的是"哪几条带角标"这个集合：页面顺序按档位变，角标不该跟着变
    const badgeSet = async (query) => (await badged(await page(query))).map((n) => n.id).sort();
    for (const query of ['', '?since=7', '?since=30', '?sort=clicks']) {
      assert.deepEqual(await badgeSet(query), [A.id, D.id].sort(), `${query || '(无参数)'} 页上带角标的应是丁与甲`);
    }
  });
});

describe('issue #62：入口与索引口径', () => {
  it('排序 / 范围入口都在，默认档位高亮，说明与实际顺序一致', async () => {
    const html = await page();
    assert.match(html, /data-testid="view-controls"/);
    assert.match(html, /data-testid="open-only-link"/);
    assert.match(html, /data-testid="since-link"/);
    assert.match(html, /按征求意见截止日期排序，即将截止的排在最前/);
    assert.equal(
      /data-testid="sort-link"[^>]*aria-current="true"[^>]*>([^<]+)</.exec(html)?.[1],
      '截止日期最近',
      '高亮的应是默认档',
    );
  });

  it('换排序后说明改口、高亮跟着换，且顺序确实是那一档', async () => {
    const html = await page('?sort=clicks');
    assert.match(html, /按提意见最多排序/);
    assert.ok(!/按征求意见截止日期排序/.test(html), '说明不能停在默认排序上');
    assertOrder(html, [C, E, A, D, B], '点击档');
    assert.equal(
      /data-testid="sort-link"[^>]*aria-current="true"[^>]*>([^<]+)</.exec(html)?.[1],
      '提意见最多',
    );
  });

  it('排序链接保留其余筛选维度（换排序不该把用户已筛出的条件丢掉）', async () => {
    const html = await page('?open=1&agency=测试甲机关');
    const hrefs = [
      ...html.matchAll(
        /<a[^>]*data-testid="sort-link"[^>]*href="([^"]*)"|<a[^>]*href="([^"]*)"[^>]*data-testid="sort-link"/g,
      ),
    ].map((match) => match[1] ?? match[2]);
    assert.equal(hrefs.length, 4, `应有 4 个排序入口，实际 ${hrefs.length}`);
    for (const href of hrefs) {
      assert.ok(href.includes('open=1'), `排序链接应带上 open=1：${href}`);
      assert.ok(href.includes('agency='), `排序链接应带上机关：${href}`);
    }
    // 默认档的链接不写 sort（首页地址保持干净，既有分享链接一字不差）
    assert.ok(hrefs.some((href) => !href.includes('sort=')), '默认档的排序链接不该带 sort 参数');
  });

  it('关键词表单留住排序与范围（否则提交一次就把用户的选择静默清掉，issue #50 同一件事）', async () => {
    const html = await page('?sort=newest&open=1&since=7');
    for (const [name, value] of [['sort', 'newest'], ['open', '1'], ['since', '7']]) {
      assert.ok(
        new RegExp(`<input[^>]*name="${name}"[^>]*value="${value}"`).test(html),
        `表单应带隐藏的 ${name}=${value}`,
      );
    }
  });

  it('排序变体仍可收录（结果集合没变），筛选变体 noindex', async () => {
    assert.equal(robotsMeta(await page('?sort=newest')), null, '排序不该产生 noindex 变体');
    assert.equal(robotsMeta(await page('?open=1')), 'noindex, follow');
    assert.equal(robotsMeta(await page('?since=7')), 'noindex, follow');
  });
});
