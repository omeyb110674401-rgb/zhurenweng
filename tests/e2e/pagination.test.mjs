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
 * E2E（issue #19）：首页分页与真实合计。
 *
 * 背景：列表此前硬编码 50 条上限且没有翻页 —— 源扩到 7 个后库内 125 条，
 * 首页只渲染前 50 条、其余从首页不可达，而「共 N 条」显示的是**本页条数**（假合计）。
 * 本场景用 `LIST_PAGE_SIZE=3`（运维可调参数，生产默认 50）把三源 fixture 的 9 条
 * 切成 3 页，逐条锁定：
 *   → 合计取真实总数（9），不是本页条数；
 *   → 逐页翻完得到的条目集合 = 全量且无重复、顺序 = 未筛选的倒计时顺序
 *     （offset 分页在确定性排序下不重复不漏行）；
 *   → 筛选后合计与总页数按筛选结果算，翻页链接保留筛选条件；
 *   → 切换筛选条件时页码归 1（筛选链接不带 page）；
 *   → 越界 / 非法页码被夹到有效范围，不出现空页或报错。
 *
 * 全程零外部依赖（ADR-0001）：SQLite 临时文件库 + 本地 fixture 源站 + stub LLM。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue19-'));
const dbFile = path.join(workDir, 'app.db');

const PAGE_SIZE = 3;
const TOTAL = 9; // 三源 fixture 跨源去重后的条数（与 category-filter 场景一致）

/** 未筛选的期望倒计时顺序（征求意见中按截止日期升序，已截止沉底）。 */
const EXPECTED_ORDER = [
  '关于公开征求《饮用水水源地基础信息数据元技术规范（征求意见稿）》等2项国家生态环境标准意见的通知',
  '关于公开征求《沿海省（区、市）近岸海域重要物种名录》意见的函',
  '企业破产法（修订草案二次审议稿）征求意见',
  '司法部关于《中华人民共和国行政复议法实施条例（修订征求意见稿）》公开征求意见的通知',
  '关于公开征求国家生态环境标准《生态环境影响评价技术导则 核动力厂（征求意见稿）》（修订HJ808-2016）意见的通知',
  '司法部、中国人民银行、金融监管总局、中国证监会、国家外汇局关于《中华人民共和国金融法（草案）》公开征求意见的通知',
  '司法部关于《行政法规制定程序条例（修订征求意见稿）》公开征求意见的通知',
  '道路交通安全法（修订草案）征求意见',
  '检察公益诉讼法（草案二次审议稿）征求意见',
];

let app;
let fixtures;

/** 单轮运行真实 worker 子进程（继承 process.env，含 fixture 源站注入）。 */
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

/** 按 <li class="notice-item"> 分块取标题（页面展示顺序）。 */
function itemTitles(html) {
  return html
    .split(/<li class="notice-item"/)
    .slice(1)
    .map((block) => block.slice(0, block.indexOf('</li>')))
    .map((block) => (/<a[^>]*notice-title-link[^>]*>([^<]+)<\/a>/.exec(block) ?? [])[1] ?? '');
}

/** 取指定 data-testid 的文本（React SSR 注释先剥掉）。 */
function testIdText(html, testId) {
  return (
    new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`).exec(stripSsrComments(html))?.[1] ?? null
  );
}

/**
 * 取指定 data-testid 链接的 href。
 * 先圈出整个 <a …> 标签再取 href —— JSX 里 href 与 data-testid 的先后顺序
 * 因组件而异，按「testid 后紧跟 href」匹配会漏（标签云就是 href 在前）。
 * 属性值里的 `&` 会被 React 转义成 `&amp;`，比较前还原。
 */
function testIdHref(html, testId) {
  const tag = new RegExp(`<a\\b[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0];
  const href = tag ? (/href="([^"]*)"/.exec(tag)?.[1] ?? null) : null;
  return href === null ? null : href.replaceAll('&amp;', '&');
}

async function fetchHome(query = '') {
  const response = await fetch(`${app.url}/${query}`);
  assert.equal(response.status, 200, `GET /${query} 应 200`);
  return response.text();
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
      // 生产默认 50；这里压到 3 以便用 9 条 fixture 驱动 3 页
      LIST_PAGE_SIZE: String(PAGE_SIZE),
    },
  });

  const run = await runWorkerOnce();
  assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('issue #19：首页分页与真实合计', () => {
  it('合计是真实总数而非本页条数；第一页含前 3 条，上一页禁用、下一页可用', async () => {
    const html = await fetchHome();
    assert.match(
      stripSsrComments(html),
      new RegExp(`共 ${TOTAL} 条`),
      `合计应为全量 ${TOTAL} 条（不是本页 ${PAGE_SIZE} 条）`,
    );
    assert.equal(itemTitles(html).length, PAGE_SIZE, '第一页渲染 3 条');
    assert.equal(testIdText(html, 'pagination-status'), `第 1 / 3 页`);
    assert.equal(testIdText(html, 'notice-range'), `当前第 1 / 3 页（第 1–${PAGE_SIZE} 条）。`);
    assert.ok(testIdText(html, 'pagination-prev-disabled'), '第一页的上一页是禁用态');
    assert.equal(testIdHref(html, 'pagination-next'), '/?page=2', '下一页链接指向第 2 页');
  });

  it('逐页翻完 = 全量且无重复，顺序与未筛选的倒计时顺序一致', async () => {
    const collected = [];
    for (let page = 1; page <= Math.ceil(TOTAL / PAGE_SIZE); page += 1) {
      const query = page === 1 ? '' : `?page=${page}`;
      collected.push(...itemTitles(await fetchHome(query)));
    }
    assert.equal(collected.length, TOTAL, '翻完所有页应恰好得到全量条目');
    assert.equal(new Set(collected).size, TOTAL, 'offset 分页不应出现重复条目');
    assert.deepEqual(collected, EXPECTED_ORDER, '分页不得改变倒计时顺序');
  });

  it('末页：下一页禁用、条数为余数', async () => {
    const html = await fetchHome('?page=3');
    assert.equal(itemTitles(html).length, TOTAL - PAGE_SIZE * 2, '末页只剩余数条');
    assert.equal(testIdText(html, 'pagination-status'), '第 3 / 3 页');
    assert.ok(testIdText(html, 'pagination-next-disabled'), '末页的下一页是禁用态');
    assert.equal(testIdHref(html, 'pagination-prev'), '/?page=2');
  });

  it('越界 / 非法页码夹到有效范围，不出现空页', async () => {
    const overflow = await fetchHome('?page=999');
    assert.equal(itemTitles(overflow).length, TOTAL - PAGE_SIZE * 2, '?page=999 落到末页');
    assert.equal(testIdText(overflow, 'pagination-status'), '第 3 / 3 页');

    for (const bad of ['?page=abc', '?page=0', '?page=-2']) {
      const html = await fetchHome(bad);
      assert.equal(testIdText(html, 'pagination-status'), '第 1 / 3 页', `${bad} 应落到第 1 页`);
    }
  });

  it('筛选后合计与总页数按筛选结果算，翻页保留筛选条件', async () => {
    // 「立法与司法」命中 6 条 → 2 页
    const first = await fetchHome(`?category=${encodeURIComponent('立法与司法')}`);
    assert.match(stripSsrComments(first), /筛选后共 6 条/, '合计是筛选结果的总数');
    assert.equal(testIdText(first, 'pagination-status'), '第 1 / 2 页');
    assert.equal(
      testIdHref(first, 'pagination-next'),
      `/?category=${encodeURIComponent('立法与司法')}&page=2`,
      '翻页链接保留领域筛选',
    );

    const second = await fetchHome(
      `?category=${encodeURIComponent('立法与司法')}&page=2`,
    );
    assert.equal(itemTitles(second).length, 3, '筛选结果的第 2 页有 3 条');
    assert.ok(!/筛选后共 6 条/.test(itemTitles(second).join('')));
    assert.match(stripSsrComments(second), /筛选后共 6 条/);
    assert.equal(
      testIdHref(second, 'pagination-prev'),
      `/?category=${encodeURIComponent('立法与司法')}`,
      '第 1 页不带 page 参数（保持链接干净）',
    );

    // 两页合起来仍是筛选结果的全量且无重复
    const combined = [...itemTitles(first), ...itemTitles(second)];
    assert.equal(combined.length, 6);
    assert.equal(new Set(combined).size, 6);
  });

  it('切换筛选条件时页码归 1（筛选链接不带 page）', async () => {
    const onPage2 = await fetchHome('?page=2');
    const chipHref = testIdHref(onPage2, 'category-filter-link');
    assert.ok(chipHref, '第 2 页应仍渲染领域标签云');
    assert.ok(!chipHref.includes('page='), `筛选链接不应带页码，实际：${chipHref}`);

    // 从第 2 页点进某个领域 → 落在该筛选结果的第 1 页
    const target = await fetchHome(chipHref);
    assert.equal(testIdText(target, 'pagination-status'), '第 1 / 2 页', '换筛选后回到第 1 页');
  });

  it('单页结果不渲染分页控件', async () => {
    // 「数据与网络安全」命中 1 条（饮用水水源地数据元）
    const html = await fetchHome(`?category=${encodeURIComponent('数据与网络安全')}`);
    assert.match(stripSsrComments(html), /筛选后共 1 条/);
    assert.ok(!/data-testid="notice-pagination"/.test(html), '单页时不渲染分页导航');
    assert.ok(!/data-testid="notice-range"/.test(html), '单页时不渲染页码区间文案');
  });
});
