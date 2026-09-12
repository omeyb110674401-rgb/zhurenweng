import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import * as cheerio from 'cheerio';
import { startAppServer } from './helpers/app-server.mjs';
import { createFixtureServer } from './helpers/fixture-server.mjs';

/**
 * E2E（issue #6）：全量 RSS 2.0 feed（/feed.xml）。
 *
 * 专用 fixture 快照（fixtures/e2e-feed/npc/，与 fixtures/npc 同构但独立成目录，
 * 不影响既有场景的条目计数断言；条目 1 标题含 & 与 < 字符）
 *   → 触发抓取（真实 worker 进程，WORKER_ONCE=1，SOURCES_FIXTURE_BASE 注入 fixture 源站）
 *   → /feed.xml：channel 结构（title/link/description/language/lastBuildDate/
 *     atom:link self）+ item（title / link 绝对 URL / guid / pubDate / description）
 *   → 排序：按发布日期倒序；AI 摘要就绪条目含显著标注的摘要片段，
 *     未就绪（已截止、摘要未生成）条目 description 无 AI 内容
 *   → 转义：& / < 标题在 XML 中正确转义，全文档无裸 & 残留
 *   → 上限：补插 205 条合成条目后 feed 恰好保留最新 200 条
 *
 * 全程零外部依赖（ADR-0001）：SQLite 临时文件库 + 本地 fixture 源站 + stub LLM。
 * XML 解析用仓库既有依赖 cheerio（xmlMode），不引入新依赖。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures', 'e2e-feed');
const workDir = mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue6-'));
const dbFile = path.join(workDir, 'app.db');

const FEED_MAX_ITEMS = 200;
/** 批量合成条目数：3 条 fixture + 205 条 > 200 上限，验证截断 */
const BULK_COUNT = 205;
const AGENCY = '全国人民代表大会常务委员会法制工作委员会';

const TITLES = {
  special: '中华人民共和国航道法（修订草案）<征求意见稿>&配套说明征求意见',
  open: '中华人民共和国公民身份证法（修正草案）征求意见',
  closed: '中华人民共和国渔业法（修订草案）征求意见',
};

const DETAILS = {
  special: '/npc/c2/c30834/t20260912_160001.html',
  open: '/npc/c2/c30834/t20260901_160002.html',
  closed: '/npc/c2/c30834/t20260815_160003.html',
};

let app;
let fixtures;
let fixtureUrl;

/** 与抓取管线一致的条目主键：原文 URL 的 SHA-256 前缀。 */
function noticeIdFor(url) {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

/** 单轮运行真实 worker 子进程，返回 { code, output }。 */
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

/** 从 fixture 源站取已替换日期令牌的截止日期，归一化为 ISO（YYYY-MM-DD）。 */
async function servedDeadline(detailPath) {
  const response = await fetch(`${fixtureUrl}${detailPath}`);
  const html = await response.text();
  const iso = /征求意见截止日期：(\d{4}-\d{1,2}-\d{1,2})/.exec(html);
  const cn = /征求意见截止日期：(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(html);
  assert.ok(iso || cn, `fixture 详情页应含已替换的截止日期：${detailPath}`);
  if (iso) return iso[1];
  const [, y, m, d] = cn;
  return `${y}-${String(Number(m)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`;
}

/** RFC 822 日期（RSS pubDate）：周几缩写 + dd + 月份缩写 + yyyy HH:mm:ss GMT */
function assertRfc822(text) {
  assert.match(
    text,
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/,
    `pubDate 应为 RFC 822 格式，实际：${text}`,
  );
}

/** 解析 feed XML（cheerio xmlMode），返回 { xml, $, items }。 */
async function fetchFeed() {
  const response = await fetch(`${app.url}/feed.xml`);
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('content-type'),
    'application/rss+xml; charset=utf-8',
    'Content-Type 应为 application/rss+xml; charset=utf-8',
  );
  const xml = await response.text();
  const $ = cheerio.load(xml, { xmlMode: true });
  return { xml, $, items: $('item').toArray() };
}

/** 提取 item 的字段（cheerio 解析后实体已解码）。 */
function itemFields(item) {
  const $ = cheerio.load(item, { xmlMode: true });
  const root = $.root().children().first();
  return {
    title: root.children('title').text(),
    link: root.children('link').text(),
    guid: root.children('guid').text(),
    pubDate: root.children('pubDate').text(),
    description: root.children('description').text(),
  };
}

/** 本地日历日（UTC 展开）- N 天的 ISO 日期（YYYY-MM-DD）。 */
function isoDateMinusDays(baseIso, days) {
  const [y, m, d] = baseIso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d - days));
  return date.toISOString().slice(0, 10);
}

before(async () => {
  fixtures = createFixtureServer({ fixturesDir });
  fixtureUrl = (await fixtures.start()).url;

  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      // 关键注入：源适配器列表页指向本地 fixture 源站
      SOURCES_FIXTURE_BASE: fixtureUrl,
    },
  });
  // SITE_URL 在服务器启动后注入（进程内环境变量；feed 端点每次请求实时读取）
  process.env.SITE_URL = app.url;
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
  // 不清理 workDir：Windows 上已打开的 SQLite 句柄会令 rmSync EPERM，
  // 临时目录交由操作系统回收（与既有场景一致）。
});

describe('issue #6：全量 RSS feed（/feed.xml）', () => {
  it('抓取前：feed 为空 channel 且结构有效；列表页含 RSS 自动发现与可见订阅入口', async () => {
    const { xml, $, items } = await fetchFeed();
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), '应有 XML 声明');
    assert.match(xml, /^<rss version="2\.0" xmlns:atom="http:\/\/www\.w3\.org\/2005\/Atom">$/m);
    assert.equal($('channel').length, 1);
    assert.equal(items.length, 0, '抓取前 feed 应无 item');
    assert.equal($('channel > title').text(), '主人翁 —— 政府公示信息聚合');
    assert.equal($('channel > link').text(), `${app.url}/`);
    assert.equal($('channel > language').text(), 'zh-cn');
    assertRfc822($('channel > lastBuildDate').text());
    assert.match(
      xml,
      new RegExp(`<atom:link href="${app.url}/feed\\.xml" rel="self" type="application/rss\\+xml" />`),
      'channel 应含 atom:link rel="self"',
    );

    // 列表页 RSS 入口：head 自动发现 + 页面可见入口
    const home = await fetch(`${app.url}/`);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(
      html,
      /<link[^>]*rel="alternate"[^>]*type="application\/rss\+xml"[^>]*href="\/feed\.xml"[^>]*\/>/,
      'head 应含 RSS 自动发现 <link rel="alternate">',
    );
    assert.match(html, /href="\/feed\.xml"[^>]*>\s*RSS 订阅/, '页面应含可见的 RSS 订阅入口');
  });

  it('worker 单轮抓取：fixture 条目（含 & / < 特殊标题）入库并完成就绪条目摘要', async () => {
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /源 npc 抓取完成：列表 3 条，新增 3，更新 0/);
    // 征求意见中的 2 条走 stub 摘要；已截止条目跳过
    assert.match(run.output, /摘要任务完成：成功 2 条，转人工复核 0 条/);
  });

  it('feed 条目：发布日期倒序、绝对链接 / guid / RFC 822 pubDate / description 字段正确', async () => {
    const { xml, $, items } = await fetchFeed();
    assert.equal(items.length, 3, `3 条条目都应出现在 feed 中，实际：${items.length}`);
    assert.equal($('item > title').length, 3);
    assert.equal(xml.match(/<item>/g).length, 3);

    // 排序：按发布日期倒序（2026-09-12 → 2026-09-01 → 2026-08-15）
    const fields = items.map((item) => itemFields(item));
    assert.deepEqual(
      fields.map((field) => field.title),
      [TITLES.special, TITLES.open, TITLES.closed],
    );

    // link：站内详情页绝对 URL（SITE_URL 基础）；guid：条目 ID（isPermaLink=false）
    for (const [key, title] of [
      ['special', TITLES.special],
      ['open', TITLES.open],
      ['closed', TITLES.closed],
    ]) {
      const field = fields.find((item) => item.title === title);
      const officialUrl = `${fixtureUrl}${DETAILS[key]}`;
      const expectedId = noticeIdFor(officialUrl);
      assert.equal(field.link, `${app.url}/notices/${expectedId}`, 'link 应为详情页绝对 URL');
      assert.equal(field.guid, expectedId, 'guid 应为条目 ID（sha256 前缀）');
    }
    assert.match(
      xml,
      /<guid isPermaLink="false">[0-9a-f]{16}<\/guid>/,
      'guid 应带 isPermaLink="false"',
    );

    // pubDate：RFC 822，且与发布日期一致（纯日期按 UTC 零点展开）
    const specialFields = fields[0];
    assertRfc822(specialFields.pubDate);
    assert.equal(
      new Date(specialFields.pubDate).toISOString(),
      '2026-09-12T00:00:00.000Z',
      'pubDate 应与发布日期 2026-09-12 一致',
    );

    // description：发布机关 + 截止日期 + AI 摘要片段（显著标注）+ 官方原文链接
    const specialDeadline = await servedDeadline(DETAILS.special);
    assert.ok(
      specialFields.description.includes(`发布机关：${AGENCY}`),
      `description 应含发布机关：${specialFields.description}`,
    );
    assert.ok(
      specialFields.description.includes(`截止日期：${specialDeadline}`),
      `description 应含截止日期 ${specialDeadline}：${specialFields.description}`,
    );
    assert.ok(
      specialFields.description.includes('AI 摘要（AI 生成，仅供参考，以官方原文为准）：'),
      'AI 摘要片段应带显著 AI 生成标注',
    );
    assert.ok(
      specialFields.description.includes('【stub】这是一份政府公示征求意见稿（固定测试摘要）。'),
      '摘要就绪条目应含 AI 摘要片段',
    );
    assert.ok(
      specialFields.description.includes(`官方原文：${fixtureUrl}${DETAILS.special}`),
      'description 应含官方原文链接',
    );

    const openFields = fields[1];
    assert.ok(
      openFields.description.includes('【stub】这是一份政府公示征求意见稿（固定测试摘要）。'),
      '征求意见中条目摘要就绪，应含 AI 摘要片段',
    );
    assert.ok(openFields.description.includes(`官方原文：${fixtureUrl}${DETAILS.open}`));

    // 未就绪摘要（已截止、摘要未生成）：description 无任何 AI 内容
    const closedDeadline = await servedDeadline(DETAILS.closed);
    assert.equal(
      fields[2].description,
      `发布机关：${AGENCY}；截止日期：${closedDeadline}；官方原文：${fixtureUrl}${DETAILS.closed}`,
      '未就绪摘要条目的 description 应只有机关 / 截止日期 / 官方原文，无 AI 内容',
    );
    assert.ok(!fields[2].description.includes('AI 摘要'), 'description 不应出现 AI 摘要段');
  });

  it('feed 转义：& 与 < 标题正确转义，全文档无裸 & 残留', async () => {
    const { xml } = await fetchFeed();
    // 原始字符（& 与 <）不得以未转义形式出现在 XML 中
    assert.ok(!xml.includes('（修订草案）<征求意见稿>'), '标题中的 < 必须转义');
    assert.ok(!xml.includes('&配套说明'), '标题中的 & 必须转义');
    // 转义后的原始文本形态存在
    assert.ok(
      xml.includes('<title>中华人民共和国航道法（修订草案）&lt;征求意见稿&gt;&amp;配套说明征求意见</title>'),
      '标题应转义为 &lt; / &amp; 实体',
    );
    // 全文档级检查：剥离合法 XML 实体后不允许残留任何裸 &
    const withoutEntities = xml.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, '');
    assert.ok(!withoutEntities.includes('&'), '剥离合法实体后不应残留裸 & 字符');
  });

  it('feed 上限 200：补插 205 条合成条目后恰好保留最新 200 条且顺序稳定', async () => {
    // 从数据缝补插超出上限的合成条目（与既有场景一致，抓取管线暂不产出）；
    // 全部为已截止状态（不参与摘要），发布日期自 2026-08-14 起逐日回退且互不相同
    const { upsertNotice } = await import('../../src/db/repo/notices.ts');
    for (let i = 0; i < BULK_COUNT; i += 1) {
      const padded = String(i).padStart(3, '0');
      await upsertNotice({
        id: noticeIdFor(`https://fixture.invalid/e2e-feed/bulk/${padded}`),
        sourceId: 'npc',
        title: `批量合成条目 ${padded}`,
        agency: AGENCY,
        url: `https://fixture.invalid/e2e-feed/bulk/${padded}`,
        publishedAt: isoDateMinusDays('2026-08-14', i),
        deadlineAt: '2026-01-01',
        status: 'closed',
        categoryTags: [],
        bodyText: '（合成条目：用于 RSS feed 上限与排序断言）',
        attachments: [],
        fetchedAt: '2026-08-14T00:00:00.000Z',
      });
    }

    const { $, items } = await fetchFeed();
    assert.equal(items.length, FEED_MAX_ITEMS, `feed 应恰好 ${FEED_MAX_ITEMS} 条`);

    const fields = items.map((item) => itemFields(item));
    // 前 3 位仍是 fixture 条目（发布日期最新），随后是合成条目按发布日期倒序
    assert.deepEqual(
      fields.slice(0, 3).map((field) => field.title),
      [TITLES.special, TITLES.open, TITLES.closed],
      '新抓取的条目应排在 feed 最前',
    );
    assert.equal(fields[3].title, '批量合成条目 000', '合成条目按发布日期倒序接续');
    assert.equal(fields[FEED_MAX_ITEMS - 1].title, '批量合成条目 196', '末位应是最新的第 197 条合成条目');

    const titles = new Set(fields.map((field) => field.title));
    assert.equal(
      fields.filter((field) => field.title.startsWith('批量合成条目')).length,
      FEED_MAX_ITEMS - 3,
      '合成条目应占 197 席',
    );
    assert.ok(titles.has('批量合成条目 000'));
    assert.ok(!titles.has('批量合成条目 197'), '超出上限的最旧条目应被截断');
    assert.ok(!titles.has(`批量合成条目 ${String(BULK_COUNT - 1).padStart(3, '0')}`), '最旧条目应被截断');

    // 截断后 feed 仍是结构有效的 RSS 2.0（每条目字段齐备、链接绝对）
    for (const field of fields) {
      assert.match(field.link, new RegExp(`^${app.url}/notices/[0-9a-f]{16}$`), 'link 应为绝对 URL');
      assert.match(field.guid, /^[0-9a-f]{16}$/);
      assertRfc822(field.pubDate);
      assert.ok(field.description.length > 0);
    }
    assert.equal($('channel').length, 1);
  });
});
