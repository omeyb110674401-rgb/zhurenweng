import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { startAppServer } from './helpers/app-server.mjs';
import { noticeItems } from './helpers/html.mjs';
import { FEED_DESCRIPTION, FEED_TITLE } from '../../src/lib/feed.ts';

/**
 * 端到端（issue #63）：RSS 子 feed —— `/feed.xml?<首页那套筛选参数>`。
 *
 * 这一刀的核心风险不是"生成不出 XML"，而是**两份筛选口径分家**：页面上看到 3 条、
 * 订到的 feed 给出 5 条，读者要过几天才会发现（而且会以为是站点不再更新）。
 * 所以这里最硬的一条断言是「同一条件下，首页渲染的条目集合 = feed 的条目集合」，
 * 两条路径都得走真实 HTTP（跑的是构建产物）。
 *
 * 另外钉住三件刻意的设计：
 * - feed **不吃** `sort` / `page`（RSS 阅读器按 pubDate 自己排，feed 也没有分页）——
 *   挂上不生效的参数就是假旋钮；
 * - 有条件时频道标题与描述**必须写明条件**（feed 里没有页面上下文，频道名就是全部说明）；
 * - 未知值不生效时也不加条件（否则会出现"标题说按不存在领域订阅、内容却是全量"的谎）。
 *
 * 零外部依赖（ADR-0001）：临时 SQLite + stub LLM / 邮件。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-issue63-'));
const dbFile = path.join(workDir, 'app.db');

const ECO = '生态环境';
const HEALTH = '医疗卫生';

const OPEN_RECENT = { id: 'a'.repeat(32), title: '子feed甲：未截止且新收录', tags: [ECO] };
const OPEN_OLD = { id: 'b'.repeat(32), title: '子feed乙：未截止但收录很久', tags: [ECO] };
const CLOSED = { id: 'c'.repeat(32), title: '子feed丙：已截止', tags: [HEALTH] };
const STALE_OPEN = { id: 'd'.repeat(32), title: '子feed丁：库里没改口的过期条目', tags: [ECO] };

let app;
let noticesRepo;

function stampPlusDays(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function datePlusDays(days) {
  return stampPlusDays(days).slice(0, 10);
}

/** feed XML → 条目（guid / title / link），只用正则（不引入 XML 解析依赖）。 */
function feedItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, block]) => ({
    guid: /<guid[^>]*>([^<]*)<\/guid>/.exec(block)?.[1] ?? '',
    title: /<title>([^<]*)<\/title>/.exec(block)?.[1] ?? '',
    pubDate: /<pubDate>([^<]*)<\/pubDate>/.exec(block)?.[1] ?? '',
  }));
}

async function feed(query = '') {
  const response = await fetch(`${app.url}/feed.xml${query}`, { cache: 'no-store' });
  assert.equal(response.status, 200, `/feed.xml${query} 应 200`);
  assert.match(response.headers.get('content-type') ?? '', /application\/rss\+xml/);
  const xml = await response.text();
  return {
    xml,
    items: feedItems(xml),
    channelTitle: /<channel>[\s\S]*?<title>([^<]*)<\/title>/.exec(xml)?.[1] ?? '',
    channelDescription: /<channel>[\s\S]*?<description>([^<]*)<\/description>/.exec(xml)?.[1] ?? '',
    selfHref: (
      /<atom:link href="([^"]*)"[^>]*rel="self"/.exec(xml)?.[1] ?? ''
    ).replaceAll('&amp;', '&'), // atom:link 里的 & 是 XML 实体，比对前还原
  };
}

async function home(query = '') {
  const response = await fetch(`${app.url}/${query}`, { cache: 'no-store' });
  assert.equal(response.status, 200);
  // 首页条目 → id（从详情页链接里取，与 feed 的 guid 同一标识）
  return [...noticeItems(await response.text())].map(
    (block) => /\/notices\/([0-9a-f]+)/.exec(block)?.[1] ?? '',
  );
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
  await sourcesRepo.registerSource({ id: 'e2e-feed', name: '子 feed 测试源', adapterType: 'fixture' });

  const seed = async (notice, { publishedPlusDays, deadlinePlusDays, seenPlusDays, status }) => {
    await noticesRepo.upsertNotice({
      id: notice.id,
      sourceId: 'e2e-feed',
      title: notice.title,
      agency: '测试机关',
      url: `https://source.test/${notice.id}.html`,
      publishedAt: datePlusDays(publishedPlusDays),
      deadlineAt: datePlusDays(deadlinePlusDays),
      status,
      categoryTags: notice.tags,
      bodyText: '现向社会公开征求意见。',
      attachments: [],
      fetchedAt: stampPlusDays(seenPlusDays),
    });
  };
  await seed(OPEN_RECENT, { publishedPlusDays: -5, deadlinePlusDays: 30, seenPlusDays: -2, status: 'open' });
  await seed(OPEN_OLD, { publishedPlusDays: -50, deadlinePlusDays: 20, seenPlusDays: -60, status: 'open' });
  await seed(CLOSED, { publishedPlusDays: -3, deadlinePlusDays: -10, seenPlusDays: -3, status: 'closed' });
  await seed(STALE_OPEN, { publishedPlusDays: -1, deadlinePlusDays: -1, seenPlusDays: -1, status: 'open' });

  const db = new Database(dbFile);
  db.prepare('UPDATE notices SET outbound_clicks = 40 WHERE id = ?').run(OPEN_OLD.id);
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
  // 临时库文件留给系统清：Windows 上连接释放前 rmSync 会 EPERM
});

describe('issue #63：全量 feed 的行为一字不改', () => {
  it('不带参数：频道标题与描述都是原有的那份，self 指回 /feed.xml', async () => {
    const result = await feed();
    assert.equal(result.channelTitle, FEED_TITLE);
    assert.equal(result.channelDescription, FEED_DESCRIPTION);
    assert.equal(result.selfHref, 'https://zw.test/feed.xml');
    assert.equal(result.items.length, 4);
  });

  it('顺序仍是发布日期倒序（丙 -3 在甲 -5 前，丁 -1 最先）', async () => {
    assert.deepEqual(
      (await feed()).items.map((item) => item.guid),
      [STALE_OPEN.id, CLOSED.id, OPEN_RECENT.id, OPEN_OLD.id],
    );
  });

  it('未知筛选值不生效，也不给频道加条件（否则标题会承诺一个不存在的筛选）', async () => {
    const result = await feed('?category=不存在的领域');
    assert.equal(result.channelTitle, FEED_TITLE, '未知值不筛选 ⇒ 标题不该写条件');
    assert.equal(result.items.length, 4);
    const stale = await feed('?open=0&since=abc&sort=nope&page=2');
    assert.equal(stale.channelTitle, FEED_TITLE, '不生效的参数不该改标题');
    assert.deepEqual(stale.items.map((i) => i.guid), (await feed()).items.map((i) => i.guid));
  });
});

describe('issue #63：子 feed 的内容 = 首页同一条件的结果', () => {
  it('按领域：feed 里的条目集合与首页渲染的完全相同', async () => {
    const result = await feed(`?category=${encodeURIComponent(ECO)}`);
    assert.deepEqual(
      [...result.items.map((item) => item.guid)].sort(),
      [...(await home(`?category=${encodeURIComponent(ECO)}`))].sort(),
      '同一条件下两处条目必须一致',
    );
    assert.equal(result.items.length, 3);
  });

  it('只看未截止：过期未改口的丁被排掉，与首页同一判据（展示口径）', async () => {
    const result = await feed('?open=1');
    assert.deepEqual(
      [...result.items.map((item) => item.guid)].sort(),
      [...(await home('?open=1'))].sort(),
    );
    assert.ok(!result.items.some((item) => item.guid === STALE_OPEN.id), '丁不该在未截止子 feed 里');
    assert.ok(!result.items.some((item) => item.guid === CLOSED.id));
  });

  it('最近 7 天收录：甲、丙、丁（feed 只按条件给条目，不因"它是 feed"就额外加状态判据）', async () => {
    const result = await feed('?since=7');
    assert.deepEqual(
      [...result.items.map((item) => item.guid)].sort(),
      [OPEN_RECENT.id, CLOSED.id, STALE_OPEN.id].sort(),
      '近 7 天进来的是甲、丙、丁',
    );
    assert.deepEqual([...result.items.map((i) => i.guid)].sort(), [...(await home('?since=7'))].sort());
  });

  it('两个条件叠加时仍与首页一致（组合条件最容易各处漏一项）', async () => {
    const query = `?category=${encodeURIComponent(ECO)}&open=1`;
    const result = await feed(query);
    assert.deepEqual(
      result.items.map((item) => item.guid),
      (await home(query)).sort(),
      '叠加条件下两处一致',
    );
    assert.deepEqual(result.items.map((item) => item.guid), [OPEN_RECENT.id, OPEN_OLD.id]);
  });
});

describe('issue #63：子 feed 说自己订的是什么', () => {
  it('标题带上条件，描述写明这是子 feed 并给出全量地址', async () => {
    const result = await feed(`?category=${encodeURIComponent(ECO)}&open=1`);
    assert.equal(result.channelTitle, `${FEED_TITLE} —— ${ECO} · 只看未截止`);
    assert.match(result.channelDescription, /子 feed（条件：生态环境 · 只看未截止）/);
    assert.match(result.channelDescription, /全量订阅见 \/feed\.xml/);
  });

  it('self 地址带条件（阅读器据此区分两份订阅）', async () => {
    const result = await feed('?open=1&since=7');
    assert.equal(result.selfHref, 'https://zw.test/feed.xml?open=1&since=7');
  });

  it('条件里的特殊字符在 XML 里转义（`<` 与 `&` 不得裸奔）', async () => {
    const { xml } = await feed('?q=%E3%80%8Ax%3Cy%26z%E3%80%8B');
    assert.ok(
      xml.includes(`<title>${FEED_TITLE} —— 关键词：《x&lt;y&amp;z》</title>`),
      '条件文本应按 XML 实体转义后原样出现在标题里',
    );
    const withoutEntities = xml.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, '');
    assert.ok(!withoutEntities.includes('&'), '剥离合法实体后不应残留裸 &');
  });
});

describe('issue #63：feed 不吃 sort 与 page（假旋钮宁可不做）', () => {
  it('`?sort=` 与 `?page=` 不改变条目集合与顺序', async () => {
    const plain = (await feed()).items;
    for (const query of ['?sort=clicks', '?sort=newest', '?page=2', '?page=99']) {
      const result = await feed(query);
      assert.deepEqual(result.items.map((item) => item.guid), plain.map((item) => item.guid), query);
      assert.equal(result.channelTitle, FEED_TITLE, `${query} 不是筛选条件，不该改标题`);
    }
  });

  it('即使叠加在真条件上也不改变顺序（条件筛内容，排序不掺和）', async () => {
    const withFilter = await feed(`?category=${encodeURIComponent(ECO)}`);
    const alsoSorted = await feed(`?category=${encodeURIComponent(ECO)}&sort=clicks`);
    assert.deepEqual(alsoSorted.items.map((i) => i.guid), withFilter.items.map((i) => i.guid));
    // 顺序是发布日期倒序（丁 -1 天最先），不是 clicks 档（那会把 40 次点击的乙提到最前）
    assert.equal(withFilter.items[0].guid, STALE_OPEN.id);
    assert.equal(alsoSorted.items[0].guid, STALE_OPEN.id);
    assert.notEqual(alsoSorted.items[0].guid, OPEN_OLD.id);
  });
});

describe('issue #63：首页给出子 feed 入口', () => {
  it('筛选生效时多一个「只订这一批」的链接，地址带着当前条件', async () => {
    const response = await fetch(`${app.url}/?open=1&since=7`, { cache: 'no-store' });
    const html = (await response.text()).replaceAll('<!-- -->', '');
    const href = /data-testid="filtered-rss-link"[^>]*href="([^"]*)"|href="([^"]*)"[^>]*data-testid="filtered-rss-link"/
      .exec(html);
    assert.ok(href, '筛选页应有子 feed 入口');
    // React 把属性里的 & 渲染成 &amp;（HTML 里的正确写法），浏览器请求时还原为 &
    assert.equal((href[1] ?? href[2]).replaceAll('&amp;', '&'), '/feed.xml?open=1&since=7');
    assert.match(html, /data-testid="rss-feed-link"/, '全量 RSS 入口保持不变');
  });

  it('没有筛选时不给这个入口（否则它和全量 feed 是同一个地址，白占一个位置）', async () => {
    const html = await (await fetch(`${app.url}/`, { cache: 'no-store' })).text();
    assert.ok(!html.includes('filtered-rss-link'), '首页无筛选时不该出现子 feed 入口');
    assert.ok(!html.includes('只订这一批'));
  });

  it('只有 sort 参数时也不算筛选（入口不该出现）', async () => {
    const html = await (await fetch(`${app.url}/?sort=clicks`, { cache: 'no-store' })).text();
    assert.ok(!html.includes('filtered-rss-link'), '换排序不改变集合，没有"这一批"可订');
  });
});
