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
 * E2E（issue #3）：首条贯穿全栈的 tracer bullet。
 *
 * fixture 人大快照（fixtures/npc/，{{CN_DATE±N}} 日期令牌按 fixture 源站启动时刻
 * 替换，保证「征求意见中 / 已截止」与倒计时断言不随运行日期衰减）
 *   → 触发抓取（真实 worker 进程，WORKER_ONCE=1，SOURCES_FIXTURE_BASE 注入 fixture 源站）
 *   → 列表页：按截止日期升序（即将截止在前）+ 倒计时 + 状态徽标
 *   → 详情页：全部字段 + 官方原文链接 + 提意指引 + AI 摘要展示（issue #4：
 *     同轮 worker 内完成摘要；已截止条目保持「摘要生成中」占位）
 *   → /go/<id>：302 至官方原文且点击计数 +1
 *   → 重复抓取：条目数不变（幂等）
 *
 * 全程零外部依赖（ADR-0001）：SQLite 临时文件库 + 本地 fixture 源站 + stub 端口。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue3-'));
const dbFile = path.join(workDir, 'app.db');

const TITLES = {
  open1: '中华人民共和国医疗保障法（草案征求意见稿）征求意见',
  open2: '中华人民共和国国家公园法（草案二次审议稿）征求意见',
  closed: '中华人民共和国渔业法（修订草案）征求意见',
};

let app;
let fixtures;
let fixtureUrl;

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

/**
 * React SSR 会在「文本 + 表达式」混排处插入 <!-- --> 注释（如
 * 「出站提意点击：<!-- -->2<!-- --> 次」），做文本断言前先剥掉。
 */
function stripSsrComments(html) {
  return html.replaceAll('<!-- -->', '');
}

/** 从详情页 HTML 提取出站提意点击数。 */
function extractOutboundClicks(rawHtml) {
  const html = stripSsrComments(rawHtml);
  const match = /出站提意点击：(\d+) 次/.exec(html);
  assert.ok(match, '详情页应展示出站提意点击计数');
  return Number(match[1]);
}

/** 从列表页 HTML 按展示顺序提取条目（标题 + 详情链接）。 */
function extractListItems(html) {
  const anchors = [...html.matchAll(/<a[^>]*notice-title-link[^>]*>([^<]+)<\/a>/g)];
  return anchors.map((match) => ({
    title: match[1].trim(),
    href: (match[0].match(/href="([^"]+)"/) ?? [])[1],
  }));
}

/**
 * 聚合列表自 issue #5 起为多源并存（npc / moj / govcn 条目同页展示）。
 * 按 <li class="notice-item"> 分块提取每条的标题 / 状态徽标 / 倒计时，
 * 供本场景只对 npc 条目作逐条断言。
 */
function extractItemBlocks(html) {
  return html
    .split(/<li class="notice-item"/)
    .slice(1)
    .map((block) => block.slice(0, block.indexOf('</li>')))
    .map((block) => ({
      title: (/<a[^>]*notice-title-link[^>]*>([^<]+)<\/a>/.exec(block) ?? [])[1] ?? '',
      badge: (/<span[^>]*notice-status-badge[^>]*>([^<]+)<\/span>/.exec(block) ?? [])[1] ?? null,
      countdown:
        (/<span[^>]*notice-countdown[^>]*>([^<]+)<\/span>/.exec(block) ?? [])[1] ?? null,
    }));
}

/** 取指定标题条目的详情链接（聚合列表含多源条目，不能按位置取）。 */
function hrefOf(items, title) {
  const item = items.find((candidate) => candidate.title === title);
  assert.ok(item, `列表页应含条目「${title}」`);
  return item.href;
}

/** 从详情页 HTML 解析出条目 ID（/notices/<id> 的 <id>）。 */
function extractNoticeId(href) {
  const match = /\/notices\/([0-9a-f]+)$/.exec(href ?? '');
  assert.ok(match, `详情链接应形如 /notices/<id>，实际：${href}`);
  return match[1];
}

/** 从 fixture 源站取已替换令牌的详情页，解析截止日期并计算距今天的日历天数。 */
async function expectedDaysUntilDeadline(detailPath) {
  const response = await fetch(`${fixtureUrl}${detailPath}`);
  const html = await response.text();
  const match = /征求意见截止日期：(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(html);
  assert.ok(match, 'fixture 详情页应含已替换的中文截止日期');
  const [, y, m, d] = match;
  const now = new Date();
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const deadlineUtc = Date.UTC(Number(y), Number(m) - 1, Number(d));
  return Math.round((deadlineUtc - todayUtc) / (24 * 60 * 60 * 1000));
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
      // 关键注入：全部源适配器的列表页指向本地 fixture 源站（SOURCES_FIXTURE_BASE）
      SOURCES_FIXTURE_BASE: fixtureUrl,
    },
  });
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('issue #3：全国人大源 → 入库 → 列表/详情 → 出站跳转', () => {
  it('抓取前：首页为空态', async () => {
    const response = await fetch(`${app.url}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /暂无公示条目/);
  });

  it('worker 单轮抓取：fixture 快照入库，列表页按截止日期升序 + 倒计时 + 状态徽标', async () => {
    const first = await runWorkerOnce();
    assert.equal(first.code, 0, `worker 应正常退出，输出：${first.output}`);
    assert.match(first.output, /源 npc 抓取完成：列表 3 条，新增 3，更新 0/);

    // 首轮抓取前首页请求已触发建库，这里再确认列表内容。
    // 聚合列表为多源并存（含 issue #5 的 moj / govcn 条目），本场景只对
    // npc 的 3 条作断言：各自恰好一次、相对顺序保持（截止升序、已截止沉底）。
    const response = await fetch(`${app.url}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    const npcBlocks = extractItemBlocks(html).filter((block) =>
      Object.values(TITLES).includes(block.title),
    );
    assert.equal(
      npcBlocks.length,
      3,
      `列表页应含 npc 的 3 条条目（各恰好一次），实际 HTML：${html.slice(0, 500)}`,
    );
    assert.deepEqual(
      npcBlocks.map((block) => block.title),
      [TITLES.open1, TITLES.open2, TITLES.closed],
    );

    // 徽标与倒计时逐条对应 npc 条目（仅征求意见中的条目展示倒计时）
    assert.deepEqual(
      npcBlocks.map((block) => block.badge),
      ['征求意见中', '征求意见中', '已截止'],
    );
    const expectedDays = await expectedDaysUntilDeadline('/npc/c2/c30834/t20260830_150001.html');
    assert.equal(npcBlocks[0].countdown, `剩 ${expectedDays} 天`);
    assert.match(npcBlocks[1].countdown, /剩 \d+ 天/);
    assert.equal(npcBlocks[2].countdown, null);

    // 列表条目元信息：发布机关与发布日期
    const visibleText = stripSsrComments(html);
    assert.match(visibleText, /全国人民代表大会常务委员会法制工作委员会/);
    assert.match(visibleText, /发布：2026-08-30/);
  });

  it('详情页：全部字段、官方原文链接、分步提意指引与 AI 摘要展示', async () => {
    const listResponse = await fetch(`${app.url}/`);
    const listHtml = await listResponse.text();
    const noticeId = extractNoticeId(hrefOf(extractListItems(listHtml), TITLES.open1));

    const response = await fetch(`${app.url}/notices/${noticeId}`);
    assert.equal(response.status, 200);
    const html = await response.text();

    // 全部字段
    assert.match(html, new RegExp(TITLES.open1));
    assert.match(html, /发布机关[\s\S]{0,40}全国人民代表大会常务委员会法制工作委员会/);
    assert.match(html, /全国人大网·法律草案征求意见/, '应展示来源（源适配器名称）');
    assert.match(html, /2026-08-30/, '发布日期');
    assert.match(html, /征求意见中/, '状态徽标');
    assert.match(html, /社会公开征求意见/, '正文纯文本');
    assert.match(html, /第一条/, '正文纯文本');
    assert.match(
      html,
      /中华人民共和国医疗保障法（草案征求意见稿）\.pdf/,
      '附件清单：草案文本',
    );
    assert.match(html, /关于《中华人民共和国医疗保障法（草案征求意见稿）》的说明\.pdf/, '附件清单：说明');

    // 官方原文链接 = fixture 源站上的快照地址
    const officialUrl = `${fixtureUrl}/npc/c2/c30834/t20260830_150001.html`;
    assert.ok(
      html.includes(`href="${officialUrl}"`),
      `详情页应含官方原文链接 ${officialUrl}`,
    );
    assert.match(html, /官方原文：/);

    // 出站按钮走站内跳转端点 + 分步提意指引
    // （不依赖属性顺序：先抓整个 <a> 锚点，再在其中找 href 与 testid）
    const goAnchor = /<a\b([^>]*)>(去官方渠道提意见)<\/a>/.exec(html);
    assert.ok(goAnchor, '详情页应有「去官方渠道提意见」按钮');
    const goHref = /href="\/go\/([0-9a-f]+)"/.exec(goAnchor[1]);
    assert.ok(goHref, `按钮应指向 /go/<id>，实际属性：${goAnchor[1]}`);
    assert.equal(goHref[1], noticeId, '按钮应指向当前条目');
    assert.match(goAnchor[1], /go-official-button/, '按钮应带 go-official-button 标识');
    assert.match(html, /分步提意指引/);
    assert.match(html, /本站只引流，不代替官方受理意见/);

    // 摘要位（issue #4）：同一 worker 轮次内抓取后即执行摘要任务（stub LLM），
    // 未截止条目详情页渲染五段式摘要 + 显著 AI 标注，不再显示占位。
    assert.match(html, /data-testid="ai-summary"/, '渲染 AI 摘要卡片');
    assert.match(html, /AI 生成，仅供参考，以官方原文为准/, '显著的 AI 生成标注');
    assert.match(html, /【stub】这是一份政府公示征求意见稿（固定测试摘要）。/, '五段式摘要内容');
    assert.match(html, /data-testid="summary-quote"/, '摘要附原文引用（可点击跳官方原文）');
    assert.ok(!html.includes('摘要生成中'), '摘要完成后占位消失');

    // 已截止条目不参与摘要（issue #4）：仍显示「摘要生成中」占位
    const closedHtml = await (
      await fetch(`${app.url}/notices/${extractNoticeId(items[2].href)}`)
    ).text();
    assert.match(closedHtml, /data-testid="summary-placeholder"/, '占位块保留');
    assert.match(closedHtml, /摘要生成中/);
    assert.ok(!closedHtml.includes('待人工复核'), '已截止条目未被尝试摘要，非待复核状态');
  });

  it('出站跳转：/go/<id> 记录点击并 302 到官方原文 URL', async () => {
    const listHtml = await (await fetch(`${app.url}/`)).text();
    const noticeId = extractNoticeId(hrefOf(extractListItems(listHtml), TITLES.open1));
    const officialUrl = `${fixtureUrl}/npc/c2/c30834/t20260830_150001.html`;

    for (const round of [1, 2]) {
      const response = await fetch(`${app.url}/go/${noticeId}`, { redirect: 'manual' });
      assert.equal(response.status, 302, `第 ${round} 次点击应 302`);
      assert.equal(response.headers.get('location'), officialUrl, '应 302 到官方原文 URL');
      assert.equal(response.headers.get('set-cookie'), null, '不记录任何个人身份（无 Cookie）');
    }

    // 点击计数 +2（详情页展示，北极星指标）
    const detailHtml = await (await fetch(`${app.url}/notices/${noticeId}`)).text();
    assert.equal(extractOutboundClicks(detailHtml), 2);

    // 不存在的条目返回 404
    const missing = await fetch(`${app.url}/go/0000000000000000`);
    assert.equal(missing.status, 404);
  });

  it('重复抓取幂等：条目数与点击计数不变', async () => {
    const second = await runWorkerOnce();
    assert.equal(second.code, 0, `worker 应正常退出，输出：${second.output}`);
    assert.match(second.output, /源 npc 抓取完成：列表 3 条，新增 0，更新 3/);

    const html = await (await fetch(`${app.url}/`)).text();
    // 重复抓取不产生重复条目：npc 的 3 条各自仍恰好一次、顺序不变
    // （聚合列表同时含其他源条目，全列表总数断言由 issue #5 场景负责）
    const npcBlocks = extractItemBlocks(html).filter((block) =>
      Object.values(TITLES).includes(block.title),
    );
    assert.deepEqual(
      npcBlocks.map((block) => block.title),
      [TITLES.open1, TITLES.open2, TITLES.closed],
      '条目与顺序保持稳定（同一 id 同一行）',
    );

    const noticeId = extractNoticeId(hrefOf(extractListItems(html), TITLES.open1));
    const detailHtml = await (await fetch(`${app.url}/notices/${noticeId}`)).text();
    assert.equal(extractOutboundClicks(detailHtml), 2, '重复抓取不得清零出站点击计数');
  });
});
