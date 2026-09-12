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
 * E2E（issue #4）：AI 摘要器接入与详情页摘要展示。
 *
 * 测试用 fixture 快照（复制 fixtures/npc/ 到临时目录，可中途追加新条目）
 *   → worker 单轮（WORKER_ONCE=1）：抓取入库 + 摘要任务（stub LLM，经环境变量注入）
 *   → 失败路径：LLM_STUB_FAILURES=always —— 每条目首调 + 3 次重试全部失败
 *     （stub 调用日志 JSONL 精确断言 4 次尝试）→ summary_status=failed_review，
 *     详情页显示「摘要生成中（待人工复核）」占位；后续正常轮次不再自动重试；
 *   → 成功路径：向 fixture 列表追加第 4 条（未截止）→ 再跑一轮 → 五段式摘要
 *     （这是什么 / 影响谁 / 关键条款 / 截止日期 / 如何提意见）+ 每段原文引用
 *     （可点击跳转官方原文）+ 显著 AI 标注，占位消失。
 *
 * 全程零外部依赖（ADR-0001）：SQLite 临时文件库 + 本地 fixture 源站 + stub LLM。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue4-'));
const dbFile = path.join(workDir, 'app.db');
const callsFile = path.join(workDir, 'llm-calls.jsonl');
const tempFixturesDir = path.join(workDir, 'fixtures');

const TITLES = {
  open1: '中华人民共和国医疗保障法（草案征求意见稿）征求意见',
  open2: '中华人民共和国国家公园法（草案二次审议稿）征求意见',
  closed: '中华人民共和国渔业法（修订草案）征求意见',
};
/** 成功路径追加的临时 fixture 条目（同法草案重新公开征求意见的合成场景，URL 不同 → 新条目） */
const NEW_TITLE = '中华人民共和国医疗保障法（草案征求意见稿）二次征求意见';
const NEW_DETAIL_FILENAME = 't20260901_150004.html';

let app;
let fixtures;
let fixtureUrl;

/** 单轮运行真实 worker 子进程，extraEnv 仅注入本次运行。返回 { code, output }。 */
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

function readCalls() {
  if (!fs.existsSync(callsFile)) return [];
  return fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean);
}

function matchCount(text, regex) {
  return (text.match(regex) ?? []).length;
}

/** 从列表页 HTML 按展示顺序提取条目（标题 + 详情链接）。 */
function extractListItems(html) {
  const anchors = [...html.matchAll(/<a[^>]*notice-title-link[^>]*>([^<]+)<\/a>/g)];
  return anchors.map((match) => ({
    title: match[1].trim(),
    href: (match[0].match(/href="([^"]+)"/) ?? [])[1],
  }));
}

/** 从详情链接解析条目 ID（/notices/<id>）。 */
function extractNoticeId(href) {
  const match = /\/notices\/([0-9a-f]+)$/.exec(href ?? '');
  assert.ok(match, `详情链接应形如 /notices/<id>，实际：${href}`);
  return match[1];
}

/** React SSR 会在文本 + 表达式混排处插入 <!-- --> 注释，文本断言前剥掉。 */
function stripSsrComments(html) {
  return html.replaceAll('<!-- -->', '');
}

before(async () => {
  // 测试私有 fixture 副本：成功路径会向列表追加第 4 条，不改仓库 fixtures/
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
      // stub LLM 调用日志：跨进程断言真实调用次数（重试次数）的关键
      LLM_STUB_CALLS_FILE: callsFile,
      // 重试退避基数调小，失败路径的总耗时可忽略
      SUMMARY_RETRY_DELAY_MS: '10',
      SOURCES_FIXTURE_BASE: fixtureUrl,
    },
  });
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('issue #4：AI 摘要器 → 五段式摘要展示（失败重试与成功两条路径）', () => {
  it('失败路径：stub 全部失败，每条目首调 + 3 次重试后转人工复核，页面显示待复核占位', async () => {
    const first = await runWorkerOnce({ LLM_STUB_FAILURES: 'always' });
    assert.equal(first.code, 0, `worker 应正常退出，输出：${first.output}`);
    assert.match(first.output, /源 npc 抓取完成：列表 3 条，新增 3，更新 0/);

    // 2 条征求意见中条目各自重试 3 次：输出含 2 组「第 3/3 次重试」与转人工复核记录
    assert.equal(matchCount(first.output, /摘要第 3\/3 次重试/g), 2);
    assert.equal(matchCount(first.output, /已重试 3 次仍失败，转人工复核/g), 2);
    assert.match(first.output, /摘要任务完成：成功 0 条，转人工复核 2 条/);

    // stub 调用日志：2 条 × （首调 1 + 重试 3）= 8 次真实调用
    assert.equal(readCalls().length, 8, '每条摘要条目应恰好尝试 4 次（1 首调 + 3 重试）');

    // 详情页：失败条目显示「待人工复核」占位而非空白，也不渲染摘要内容
    const listHtml = await (await fetch(`${app.url}/`)).text();
    const items = extractListItems(listHtml);
    assert.equal(items.length, 3);
    const openId = extractNoticeId(items[0].href);

    const openHtml = await (await fetch(`${app.url}/notices/${openId}`)).text();
    assert.match(openHtml, /data-testid="summary-placeholder"/, '占位块保留');
    assert.match(openHtml, /摘要生成中（待人工复核）/);
    assert.match(openHtml, /data-testid="summary-review-note"/);
    assert.ok(!openHtml.includes('data-testid="ai-summary"'), '失败路径不渲染摘要卡片');
    assert.ok(!openHtml.includes('【stub】'), '失败路径无摘要内容');

    // 已截止条目不参与摘要：仍是普通「摘要生成中」占位（无待复核标注）
    const closedId = extractNoticeId(items[2].href);
    const closedHtml = await (await fetch(`${app.url}/notices/${closedId}`)).text();
    assert.match(closedHtml, /data-testid="summary-placeholder"/);
    assert.match(closedHtml, /摘要生成中/);
    assert.ok(!closedHtml.includes('待人工复核'), '已截止条目未被尝试摘要');
  });

  it('转人工复核后不再自动重试：stub 恢复正常也不会补跑失败条目', async () => {
    const second = await runWorkerOnce();
    assert.equal(second.code, 0, `worker 应正常退出，输出：${second.output}`);
    assert.match(second.output, /无待摘要条目/, 'failed_review 与已截止条目都不再进入扫描');
    assert.equal(readCalls().length, 8, '本轮不应产生任何新的 LLM 调用');

    const listHtml = await (await fetch(`${app.url}/`)).text();
    const openId = extractNoticeId(extractListItems(listHtml)[0].href);
    const html = await (await fetch(`${app.url}/notices/${openId}`)).text();
    assert.match(html, /摘要生成中（待人工复核）/, '待复核状态保持不变');
  });

  it('成功路径：新入库条目生成五段式摘要，AI 标注 + 原文引用可点击，占位消失', async () => {
    // 向临时 fixture 列表追加第 4 条（未截止，截止日期 +30 天）：同法重新公开征求意见，URL 不同
    const detailDir = path.join(tempFixturesDir, 'npc', 'c2', 'c30834');
    const baseDetail = fs.readFileSync(path.join(detailDir, 't20260830_150001.html'), 'utf8');
    fs.writeFileSync(
      path.join(detailDir, NEW_DETAIL_FILENAME),
      baseDetail
        .replaceAll('{{CN_DATE+21}}', '{{CN_DATE+30}}')
        .replaceAll(TITLES.open1, NEW_TITLE),
    );
    const listPath = path.join(tempFixturesDir, 'npc', 'list.html');
    const listHtml = fs.readFileSync(listPath, 'utf8');
    const newItem = [
      '        <li>',
      `          <a href="/npc/c2/c30834/${NEW_DETAIL_FILENAME}" target="_blank">${NEW_TITLE}</a>`,
      '          <span class="time">2026年9月1日</span>',
      '        </li>',
      '',
    ].join('\n');
    fs.writeFileSync(listPath, listHtml.replace('</ul>', `${newItem}</ul>`));

    const third = await runWorkerOnce();
    assert.equal(third.code, 0, `worker 应正常退出，输出：${third.output}`);
    assert.match(third.output, /源 npc 抓取完成：列表 4 条，新增 1，更新 3/);
    assert.match(third.output, /摘要任务完成：成功 1 条，转人工复核 0 条/);
    assert.equal(readCalls().length, 9, '仅新条目产生 1 次 LLM 调用（一次成功）');

    // 详情页：五段式摘要 + 显著 AI 标注 + 每段原文引用（可点击跳官方原文）
    // （列表按截止日期排序，新条目按标题定位而非固定下标）
    const listAfter = await (await fetch(`${app.url}/`)).text();
    const items = extractListItems(listAfter);
    assert.equal(items.length, 4, '列表应包含追加后的 4 条条目');
    const appended = items.find((item) => item.title === NEW_TITLE);
    assert.ok(appended, '列表应包含新追加条目');
    const newId = extractNoticeId(appended.href);
    const officialUrl = `${fixtureUrl}/npc/c2/c30834/${NEW_DETAIL_FILENAME}`;

    const rawHtml = await (await fetch(`${app.url}/notices/${newId}`)).text();
    const html = stripSsrComments(rawHtml);

    assert.match(rawHtml, /data-testid="ai-summary"/, '渲染摘要卡片');
    assert.ok(!html.includes('摘要生成中'), '占位消失');
    assert.match(html, /AI 生成，仅供参考，以官方原文为准/, '显著的 AI 生成标注');

    // 五段式内容（stub 固定摘要基准）
    assert.match(html, /【stub】这是一份政府公示征求意见稿（固定测试摘要）。/, '这是什么');
    assert.match(html, /【stub】受该草案影响的公众与相关主体（固定测试文案）。/, '影响谁');
    assert.match(html, /【stub】关键条款一/, '关键条款一');
    assert.match(html, /【stub】关键条款二/, '关键条款二');
    assert.match(html, /【stub】请前往官方原文页面按指引提交意见。/, '如何提意见');
    assert.match(html, /2026-12-31/, '截止日期段展示摘要中的截止日期');
    for (const testId of [
      'summary-what',
      'summary-who',
      'summary-key-points',
      'summary-deadline',
      'summary-how-to-comment',
    ]) {
      assert.match(rawHtml, new RegExp(`data-testid="${testId}"`), `五段式段落：${testId}`);
    }

    // 每段附原文引用：2 关键条款 + 4 正文段 = 6 处引用，全部一键跳转官方原文
    const quoteAnchors = [...rawHtml.matchAll(/<a\b[^>]*data-testid="summary-quote"[^>]*>/g)];
    assert.equal(quoteAnchors.length, 6, '五段式各段均带原文引用块');
    for (const anchor of quoteAnchors) {
      assert.ok(
        anchor[0].includes(`href="${officialUrl}"`),
        `引用应可点击定位到官方原文，实际属性：${anchor[0]}`,
      );
    }
    assert.match(html, /「社会公开征求意见。」/, '引用展示原文片段');

    // 摘要模型名随标注展示（stub 场景即 provider 名）
    assert.match(html, /摘要模型：stub/);
  });
});
