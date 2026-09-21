import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { startAppServer } from './helpers/app-server.mjs';
import { createFixtureServer } from './helpers/fixture-server.mjs';
import { noticeItems } from './helpers/html.mjs';

/**
 * E2E（issue #30）：抓取降级 —— 详情抓取失败**不得覆盖**已入库的详情层数据。
 *
 * ## 为什么需要这个场景（线上实测的现场）
 *
 * 2026-09-21 生产库出现一条无正文条目：交通运输部栏目里的跨域条目
 * 「中国民航局关于《运输机场运营许可规定（征求意见稿）》…」，同一轮日志里有
 * `详情页抓取失败（保留列表层数据）url=https://www.caac.gov.cn/…：fetch failed`。
 * issue #24 复核时这条正文是全的 —— 即一次偶发网络失败把它抹掉了。
 *
 * 根因：`upsertNotice` 是整行覆盖写，而失败分支交回的是**列表层数据**
 * （bodyText / deadlineAt / attachments 全 null）。后果不止丢正文：
 * 截止日期一丢，`deriveStatus` 会退回「源标注 ?? 默认 open」，
 * **已截止条目会翻回「征求意见中」**。
 *
 * ## 场景构造
 *
 * 用 `fixtures/e2e-cac` 的快照副本（拷到临时目录，便于在测试中间删文件）：
 *
 * 1. 第一轮：三条详情齐全 → 正文 / 截止日期 / 附件都入库；
 * 2. 删掉其中一条的详情快照（fixture 源站对它返回 404，等价于真实站点的偶发失败）；
 * 3. 第二轮：断言该条目的正文 / 截止日期 / 倒计时 / 状态**都还在**，
 *    且日志如实记录了降级（不是静默吞掉）。
 *
 * 全程零外部依赖（ADR-0001）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-degrade-'));
const dbFile = path.join(workDir, 'app.db');
/** 快照副本：第二轮要删掉一个详情文件（不动仓库里的 fixture） */
const fixturesDir = path.join(workDir, 'fixtures');

/** 已截止条目：正文含邮箱 + 信函地址，截止句是「请于 X 前…」（extractDeadline 规则 3） */
const TITLE =
  '关于征求《政务移动互联网应用程序管理要求》强制性国家标准（征求意见稿）意见的通知';
/** 该条目的详情快照相对路径（删除它来模拟详情抓取失败） */
const DETAIL_FILE = path.join('cac', '2026-06', '26', 'c_1784217637474922.htm');

let app;
let fixtures;
let fixtureUrl;

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

/** 首页里该条目的链接与状态徽标。 */
async function listBlock() {
  const home = stripSsrComments(await (await fetch(`${app.url}/`)).text());
  const block = noticeItems(home)
    .map((chunk) => chunk.slice(0, chunk.indexOf('</li>')))
    .find((chunk) => chunk.includes(TITLE));
  assert.ok(block, `首页应含条目「${TITLE}」`);
  return {
    href: (/href="(\/notices\/[0-9a-f]+)"/.exec(block) ?? [])[1] ?? '',
    badge: (/<span[^>]*notice-status-badge[^>]*>([^<]+)<\/span>/.exec(block) ?? [])[1] ?? '',
    countdown: (/<span[^>]*notice-countdown[^>]*>([^<]+)<\/span>/.exec(block) ?? [])[1] ?? null,
  };
}

async function detailHtml() {
  const { href } = await listBlock();
  return stripSsrComments(await (await fetch(`${app.url}${href}`)).text());
}

before(async () => {
  // 快照副本（见文件头：第二轮要删一个详情文件）
  fs.cpSync(path.join(repoRoot, 'fixtures', 'e2e-cac'), fixturesDir, { recursive: true });

  fixtures = createFixtureServer({ fixturesDir });
  fixtureUrl = (await fixtures.start()).url;

  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      MAILER_OUTBOX_FILE: path.join(workDir, 'outbox.jsonl'),
      FIXTURES_DIR: fixturesDir,
      SOURCES_FIXTURE_BASE: fixtureUrl,
      SITE_URL: 'https://zw.test',
    },
  });
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('issue #30：详情抓取失败时的降级', () => {
  let firstRun;
  let baseline;

  it('第一轮：详情齐全，正文 / 截止日期 / 附件都入库', async () => {
    firstRun = await runWorkerOnce();
    assert.equal(firstRun.code, 0, `worker 应正常退出：${firstRun.output}`);
    assert.ok(!/详情页抓取失败/.test(firstRun.output), `第一轮不应有降级：${firstRun.output}`);

    baseline = await listBlock();
    assert.match(baseline.badge, /已截止/, '该条截止日期在负偏移，应为已截止');
    const detail = await detailHtml();
    assert.match(detail, /组织完成了《政务移动互联网应用程序管理要求》/, '正文应入库');
    assert.match(detail, /data-testid="notice-attachments"/, '附件应入库');
    assert.match(detail, /强制性国家标准反馈意见表<\/a>/, '附件名应来自 fText');
  });

  it('第二轮（详情 404）：正文 / 附件 / 截止日期 / 状态都不被抹掉', async () => {
    fs.rmSync(path.join(fixturesDir, DETAIL_FILE));

    const second = await runWorkerOnce();
    assert.equal(second.code, 0, `worker 应正常退出：${second.output}`);
    assert.match(
      second.output,
      /详情页抓取失败[^\n]*c_1784217637474922\.htm/,
      `降级应如实记日志（不静默吞掉）：${second.output}`,
    );

    const after = await listBlock();
    assert.equal(after.badge, baseline.badge, '状态不应因详情失败而改变');
    assert.equal(after.countdown, baseline.countdown, '倒计时不应因详情失败而消失');

    const detail = await detailHtml();
    assert.match(detail, /组织完成了《政务移动互联网应用程序管理要求》/, '正文应保留');
    assert.match(detail, /data-testid="notice-attachments"/, '附件清单应保留');
    assert.match(detail, /强制性国家标准反馈意见表<\/a>/, '附件名应保留');
    assert.match(detail, /截止日期<\/dt><dd>\d{4}-\d{2}-\d{2}<\/dd>/, '截止日期应保留');
  });

  it('第三轮（详情恢复）：重新抓到详情，字段照常刷新', async () => {
    // 详情恢复后不应停留在「沿用旧值」的状态：本轮拿到什么就写什么
    const source = path.join(repoRoot, 'fixtures', 'e2e-cac', DETAIL_FILE);
    fs.mkdirSync(path.dirname(path.join(fixturesDir, DETAIL_FILE)), { recursive: true });
    fs.copyFileSync(source, path.join(fixturesDir, DETAIL_FILE));

    const third = await runWorkerOnce();
    assert.equal(third.code, 0, `worker 应正常退出：${third.output}`);
    assert.ok(!/详情页抓取失败/.test(third.output), `详情恢复后不应再有降级：${third.output}`);

    const after = await listBlock();
    assert.equal(after.badge, baseline.badge);
    assert.match(await detailHtml(), /强制性国家标准反馈意见表<\/a>/, '附件仍在');
  });
});
