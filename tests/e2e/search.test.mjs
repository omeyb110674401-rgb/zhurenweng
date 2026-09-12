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
 * E2E（issue #8）：Meilisearch 全文检索与搜索 UI（测试走 local SearchPort，
 * SQLite FTS5 —— ADR-0001 第 2 条，生产 provider 为 Meilisearch 适配器）。
 *
 * 场景（抓取 → 索引 → 搜索命中）：
 *   fixture 入库（worker 单轮：抓取 + 摘要 + 索引钩子 + 全量重建）
 *   → 首页出现搜索框
 *   → 标题关键词命中（「国家公园法」只出现在标题）
 *   → 正文关键词命中（「监督检查」只出现在医疗保障法正文）
 *   → AI 摘要文本命中（stub 摘要语「固定测试摘要」，两条未截止条目）
 *   → 结果项复用列表条目展示（状态 / 机关 / 截止日期 / 详情链接）
 *   → 无关关键词返回空态
 *   → q 为空 / 未带 q 回到列表页
 *   → 更新条目正文后重新抓取，新内容可被检索命中
 *
 * 全程零外部依赖（ADR-0001）：SQLite 临时文件库 + 本地 fixture 源站 + stub LLM。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue8-'));
const dbFile = path.join(workDir, 'app.db');
const tempFixturesDir = path.join(workDir, 'fixtures');

const TITLES = {
  yibao: '中华人民共和国医疗保障法（草案征求意见稿）征求意见',
  park: '中华人民共和国国家公园法（草案二次审议稿）征求意见',
  fishery: '中华人民共和国渔业法（修订草案）征求意见',
};
/** 更新场景追加到渔业法详情正文的特征句（全仓 fixture 中不存在的关键词） */
const UPDATED_BODY_KEYWORD = '量子比特';
const UPDATED_BODY_SENTENCE =
  '环境影响评价公众意见征询过程中的量子比特安全审查试点工作同步开展。';

let app;
let fixtures;
let fixtureUrl;

/** 单轮运行真实 worker 子进程（抓取 → 摘要 → 提醒 → 检索索引重建）。 */
function runWorkerOnce(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['worker/index.ts'], {
      cwd: repoRoot,
      env: { ...process.env, WORKER_ONCE: '1', ...extraEnv },
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

/** React SSR 会在文本 + 表达式混排处插入 <!-- --> 注释，文本断言前剥掉。 */
function stripSsrComments(html) {
  return html.replaceAll('<!-- -->', '');
}

/** 从结果页 HTML 提取条目块（<li data-testid="notice-item">…</li>）。 */
function extractNoticeItems(html) {
  const items = [];
  const pattern = /<li[^>]*data-testid="notice-item"[^>]*>[\s\S]*?<\/li>/g;
  for (const match of html.matchAll(pattern)) {
    items.push(match[0]);
  }
  return items;
}

before(async () => {
  // 测试私有 fixture 副本：更新场景会改写渔业法详情页，不动仓库 fixtures/
  fs.cpSync(path.join(repoRoot, 'fixtures', 'npc'), path.join(tempFixturesDir, 'npc'), {
    recursive: true,
  });

  fixtures = createFixtureServer({ fixturesDir: tempFixturesDir });
  fixtureUrl = (await fixtures.start()).url;

  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      SOURCES_FIXTURE_BASE: fixtureUrl,
    },
  });
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('issue #8：抓取 → 索引 → 搜索命中（SearchPort local）', () => {
  it('worker 单轮入库并同步索引（抓取钩子 + 全量重建）', async () => {
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /源 npc 抓取完成：列表 3 条，新增 3，更新 0/);
    // 入库与更新时的索引同步钩子（3 条 npc 条目）+ 注册表末位的全量重建
    assert.match(run.output, /检索索引已同步 3 条（provider=local）/);
    assert.match(run.output, /检索索引重建完成：3 条（provider=local）/);
  });

  it('首页头部渲染站内搜索框（GET 表单提交 /search）', async () => {
    const html = await (await fetch(`${app.url}/`)).text();
    assert.match(html, /data-testid="search-form"/);
    assert.match(html, /action="\/search"/);
    assert.match(html, /method="get"/);
    assert.match(html, /name="q"/);
  });

  it('标题关键词命中：「国家公园法」返回该条目并复用列表条目展示', async () => {
    const html = stripSsrComments(await (await fetch(`${app.url}/search?q=国家公园法`)).text());
    assert.match(html, /data-testid="search-query-text"[^>]*>国家公园法/);
    assert.match(html, /data-testid="search-result-count"[^>]*>共 1 条/);

    const items = extractNoticeItems(html);
    assert.equal(items.length, 1);
    assert.ok(items[0].includes(TITLES.park), `条目应为国家公园法，实际：${items[0].slice(0, 200)}`);
    // 复用列表条目展示：状态徽标（征求意见中）+ 发布机关 + 截止日期 + 详情链接
    assert.match(items[0], /data-testid="notice-status-badge"[^>]*>\s*征求意见中/);
    assert.match(items[0], /全国人民代表大会常务委员会法制工作委员会/);
    assert.match(items[0], /发布：2026-08-28/);
    assert.match(items[0], /截止：\d{4}-\d{2}-\d{2}/);
    assert.match(items[0], /data-testid="notice-title-link"/);

    // 结果项指向正确条目的详情页
    const detailHref = /href="(\/notices\/[0-9a-f]+)"/.exec(items[0])[1];
    const detail = await (await fetch(`${app.url}${detailHref}`)).text();
    assert.ok(detail.includes(TITLES.park), '结果项应链接到国家公园法详情页');
  });

  it('正文关键词命中：「监督检查」只出现在医疗保障法正文中', async () => {
    const html = stripSsrComments(await (await fetch(`${app.url}/search?q=监督检查`)).text());
    const items = extractNoticeItems(html);
    assert.equal(items.length, 1, '正文关键词应恰好命中 1 条');
    assert.ok(items[0].includes(TITLES.yibao), `应命中医疗保障法，实际：${items[0].slice(0, 200)}`);
    assert.ok(!items[0].includes(TITLES.park), '不应命中其他条目');
  });

  it('AI 摘要文本可被检索：stub 摘要语「固定测试摘要」命中两条未截止条目', async () => {
    const html = stripSsrComments(await (await fetch(`${app.url}/search?q=固定测试摘要`)).text());
    const items = extractNoticeItems(html);
    assert.equal(items.length, 2, '两条已生成摘要的未截止条目都应命中');
    const titles = items.map((item) => item);
    assert.ok(titles.some((item) => item.includes(TITLES.yibao)));
    assert.ok(titles.some((item) => item.includes(TITLES.park)));
    assert.ok(!titles.some((item) => item.includes(TITLES.fishery)), '已截止且未摘要的条目不命中');
  });

  it('无关关键词返回空态，提示友好', async () => {
    const html = stripSsrComments(await (await fetch(`${app.url}/search?q=区块链`)).text());
    assert.match(html, /data-testid="search-empty-state"/);
    assert.match(html, /没有找到与「区块链」相关的公示/);
    assert.match(html, /data-testid="search-result-count"[^>]*>共 0 条/);
    assert.equal(extractNoticeItems(html).length, 0);
    assert.ok(!html.includes('search-error-state'), 'local 检索不应触发错误态');
  });

  it('q 为空（未带参数 / 空值）回到列表页', async () => {
    for (const url of [`${app.url}/search`, `${app.url}/search?q=`]) {
      const response = await fetch(url, { redirect: 'manual' });
      assert.ok([301, 302, 303, 307, 308].includes(response.status), `应重定向，实际 ${response.status}`);
      const location = response.headers.get('location');
      assert.ok(
        location === '/' || new URL(location, app.url).pathname === '/',
        `应回到列表页 /，实际 ${location}`,
      );
    }
  });

  it('更新条目正文后重新抓取，新内容可被检索命中', async () => {
    // 向渔业法详情页正文（#UCAP-CONTENT 容器内）追加特征句（URL 不变 → upsert 更新同一行）
    const detailPath = path.join(tempFixturesDir, 'npc', 'c2', 'c30834', 't20260801_150003.html');
    const original = fs.readFileSync(detailPath, 'utf8');
    const bodyAnchor =
      '从事捕捞作业的单位和个人，应当按照捕捞许可证规定的作业类型、场所、时限和渔具数量进行作业。</p>';
    assert.ok(original.includes(bodyAnchor), 'fixture 正文锚点应存在');
    fs.writeFileSync(detailPath, original.replace(bodyAnchor, `${bodyAnchor}\n        <p>${UPDATED_BODY_SENTENCE}</p>`));

    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /源 npc 抓取完成：列表 3 条，新增 0，更新 3/);
    assert.match(run.output, /检索索引已同步 3 条（provider=local）/);

    const html = stripSsrComments(await (await fetch(`${app.url}/search?q=${UPDATED_BODY_KEYWORD}`)).text());
    const items = extractNoticeItems(html);
    assert.equal(items.length, 1, '更新后的正文关键词应恰好命中 1 条');
    assert.ok(items[0].includes(TITLES.fishery), `应命中渔业法，实际：${items[0].slice(0, 200)}`);
  });
});
