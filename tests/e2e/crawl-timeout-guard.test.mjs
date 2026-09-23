import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { createFixtureServer } from './helpers/fixture-server.mjs';
import { noticeIdForUrl } from '../../src/lib/notice-id.ts';

/**
 * E2E（issue #58）：慢源必须被**按时**掐断，而且要掐得可以说清是谁、按多少预算。
 *
 * 起因是线上实测：人大网（npc）的列表页偶发超过 15s，于是那个源每天红一次、每天一封
 * 告警邮件。修它的前提是先把超时这件事问清楚，实测否掉了一条想当然的担心 ——
 * **`AbortSignal.timeout` 在 Node 24 下同样覆盖响应体流式读取**（表头已到、对端不再吐
 * 字节，也会在预算点抛 TimeoutError）。所以本文件同时是那件事的回归守卫：
 * 1. 三档预算各按各的数掐断（显式传参 > 适配器声明 > 全局 CRAWL_TIMEOUT_MS），
 *    且**表头都不发**的停摆同样掐得住；
 * 2. 错误消息带上毫秒预算与 URL —— 按源配置若不可归因就等于没配；
 * 3. 一条停滞的详情只拖住自己那一秒，其余条目照常入库，整轮在预算内退出。
 *
 * 全程零外部依赖（ADR-0001）：SQLite 临时库 + 本地 fixture 源站的 `/__stall` 路由。
 * 夹具故意停 5s 而全局预算设 1s：掐断点因此是「1s 而不是 5s」，误差不对称、不会假绿。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue58-timeout-'));
const fixturesDir = path.join(workDir, 'fixtures');
const dbFile = path.join(workDir, 'app.db');
const outboxFile = path.join(workDir, 'outbox.jsonl');

/** 夹具的停摆时长：远大于任何一档预算，所以「没掐断」一定表现为整体超时。 */
const STALL_MS = 5000;
/** 全局预算取 envInt 的下界 1s：与夹具的 5s 差 5 倍，判据不受机器抖动影响。 */
const GLOBAL_TIMEOUT_MS = 1000;

let fixtures;
let fixtureUrl;
/** env 就位后才 import（DEFAULT_CRAWL_TIMEOUT_MS 是模块级常量）。 */
let fetchText;

function listHtml() {
  const row = (href, title) =>
    `<li><h5><a href="${href}" target="_blank" title="${title}">${title}</a></h5>` +
    '<div class="times">{{DATE-2}}</div></li>';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>网信@你</title></head>
<body><div class="main"><div id="loadingInfoPage" class="default">
${row('d1.htm', '国家互联网信息办公室关于《超时对照办法（征求意见稿）》公开征求意见的通知')}
${row(`../__stall?ms=${STALL_MS}`, '国家互联网信息办公室关于《超时停滞条目（征求意见稿）》公开征求意见的通知')}
${row('d2.htm', '国家互联网信息办公室关于《超时对照规定（征求意见稿）》公开征求意见的通知')}
</div></div></body></html>`;
}

function detailHtml(title, body) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>
<body><div class="main-title"><h1 class="title">${title}</h1>
<div class="info clearfix"><span id="pubtime">{{CN_DATE-2}} 09:30</span></div></div>
<div class="main-content"><div id="BodyLabel"><p>${body}</p>
<p>意见反馈截止日期为{{CN_DATE+20}}。</p></div></div></body></html>`;
}

function writeFixtures() {
  const cacDir = path.join(fixturesDir, 'cac');
  fs.mkdirSync(cacDir, { recursive: true });
  fs.writeFileSync(path.join(cacDir, 'list.html'), listHtml());
  fs.writeFileSync(
    path.join(cacDir, 'd1.htm'),
    detailHtml(
      '国家互联网信息办公室关于《超时对照办法（征求意见稿）》公开征求意见的通知',
      '超时对照正文一：证明掐断停滞条目没有误伤同源的其它条目。',
    ),
  );
  fs.writeFileSync(
    path.join(cacDir, 'd2.htm'),
    detailHtml(
      '国家互联网信息办公室关于《超时对照规定（征求意见稿）》公开征求意见的通知',
      '超时对照正文二。',
    ),
  );
}

async function runWorkerOnce() {
  const startedAt = Date.now();
  const { code, output } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['worker/index.ts'], {
      cwd: repoRoot,
      env: { ...process.env, WORKER_ONCE: '1' },
    });
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk;
    });
    child.stderr.on('data', (chunk) => {
      text += chunk;
    });
    child.on('error', reject);
    child.on('close', (closeCode) => resolve({ code: closeCode, output: text }));
  });
  return { code, output, elapsedMs: Date.now() - startedAt };
}

/** 墙钟上限：预算 1s，夹具停 5s —— 掐断生效则远小于 5s，没生效则必然超过本上限。 */
const WALL_CLOCK_LIMIT_MS = 4000;

async function rejectsInMs(fn) {
  const startedAt = Date.now();
  const error = await fn().then(
    () => null,
    (caught) => caught,
  );
  return { elapsedMs: Date.now() - startedAt, error };
}

before(async () => {
  writeFixtures();
  fixtures = createFixtureServer({ fixturesDir });
  fixtureUrl = (await fixtures.start()).url;

  process.env.DB_DRIVER = 'sqlite';
  process.env.DATABASE_URL = dbFile;
  process.env.LLM_PROVIDER = 'stub';
  process.env.MAILER_PROVIDER = 'stub';
  process.env.MAILER_OUTBOX_FILE = outboxFile;
  process.env.ALERT_EMAIL = 'ops@zhurenweng.example';
  process.env.SITE_URL = 'https://zw.test';
  process.env.FIXTURES_DIR = fixturesDir;
  process.env.SOURCES_FIXTURE_BASE = fixtureUrl;
  process.env.CRAWL_TIMEOUT_MS = String(GLOBAL_TIMEOUT_MS);
  // 附件抽取与本轮无关，关掉省时间（另有它自己的用例）
  process.env.ATTACHMENT_TEXT = 'off';

  fetchText = (await import('../../worker/jobs/crawl-notices.ts')).fetchText;
});

after(async () => {
  await fixtures?.stop();
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('issue #58：超时预算的三档解析与可归因错误', () => {
  const stalled = (ms = STALL_MS, extra = '') =>
    `${fixtureUrl}/__stall?ms=${ms}${extra}`;

  it('全局档：未声明时按 CRAWL_TIMEOUT_MS 掐断，消息带预算与 URL', async () => {
    const url = stalled();
    const { elapsedMs, error } = await rejectsInMs(() => fetchText(url));
    assert.ok(error, '停滞的响应体必须被掐断，不能让 read() 永远等下去');
    assert.match(
      error.message,
      new RegExp(`抓取超时（>${GLOBAL_TIMEOUT_MS}ms 未取完响应体）`),
      `预算要说得出口：${error.message}`,
    );
    assert.ok(
      error.message.includes(url),
      `没有 URL 的超时无法归因到源：${error.message}`,
    );
    assert.ok(
      elapsedMs >= GLOBAL_TIMEOUT_MS - 50 && elapsedMs < WALL_CLOCK_LIMIT_MS,
      `应在 ${GLOBAL_TIMEOUT_MS}ms 附近掐断，实测 ${elapsedMs}ms`,
    );
  });

  it('表头都不发的停摆同样掐得住（signal 覆盖 headers 阶段）', async () => {
    const { elapsedMs, error } = await rejectsInMs(() => fetchText(stalled(STALL_MS, '&before=1')));
    assert.ok(error, '对端接受连接却不发表情，也必须按预算收场');
    assert.match(error.message, /抓取超时/);
    assert.ok(elapsedMs < WALL_CLOCK_LIMIT_MS, `实测等了 ${elapsedMs}ms`);
  });

  it('适配器档：本站声明的预算优先于全局值，且写进消息里', async () => {
    const declaredMs = 300;
    const { elapsedMs, error } = await rejectsInMs(() =>
      fetchText(stalled(), { timeoutMs: declaredMs }),
    );
    assert.ok(error);
    assert.match(
      error.message,
      new RegExp(`>${declaredMs}ms`),
      `消息里的预算必须是实际生效的那一个：${error.message}`,
    );
    assert.ok(
      elapsedMs < GLOBAL_TIMEOUT_MS,
      `声明更短就该更早掐断，实测 ${elapsedMs}ms ≥ 全局 ${GLOBAL_TIMEOUT_MS}ms`,
    );
  });

  it('显式传参档：压过适配器声明（同一趟旅程只有一个数生效）', async () => {
    const { crawlFetch, readCappedBuffer } = await import('../../worker/jobs/crawl-notices.ts');
    const startedAt = Date.now();
    const error = await crawlFetch(stalled(), {
      fetchOptions: { timeoutMs: STALL_MS },
      timeoutMs: 250,
    })
      .then((response) => readCappedBuffer(response, 1024))
      .then(() => null, (caught) => caught);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(error, '显式 250ms 应压过声明的 5000ms');
    assert.ok(elapsedMs < 2000, `显式预算没生效？实测 ${elapsedMs}ms`);
  });
});

describe('issue #58：一轮抓取里停滞条目只拖住自己', () => {
  it('停滞详情按预算掐断并说明原因，其余条目正文照常入库', async () => {
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出：${run.output}`);
    assert.ok(
      run.elapsedMs < 30_000,
      `一条停滞不该把整轮拖长：本轮 ${run.elapsedMs}ms\n${run.output}`,
    );

    assert.match(
      run.output,
      new RegExp(`抓取超时（>${GLOBAL_TIMEOUT_MS}ms 未取完响应体）：${fixtureUrl}/__stall`),
      `停滞详情要说清预算与地址：${run.output}`,
    );
    assert.match(run.output, /源 cac 抓取完成：列表 3 条，新增 3，更新 0，详情失败 1，入库失败 0/);
    assert.ok(
      !/源 cac 数据质量降级/.test(run.output),
      `3 条里 1 条失败不到降级线：${run.output}`,
    );

    const db = new Database(dbFile, { readonly: true });
    try {
      const stalledId = noticeIdForUrl(`${fixtureUrl}/__stall?ms=${STALL_MS}`);
      const normalId = noticeIdForUrl(`${fixtureUrl}/cac/d1.htm`);
      const stalledRow = db
        .prepare('select body_text from notices where id = ?')
        .get(stalledId);
      const normalRow = db.prepare('select body_text from notices where id = ?').get(normalId);
      assert.ok(stalledRow, '停滞条目仍以列表层数据入库');
      assert.equal(stalledRow.body_text, null, '没抓到的正文不该被编出来');
      assert.match(
        normalRow?.body_text ?? '',
        /超时对照正文一/,
        '同源的其它条目必须不受影响',
      );
    } finally {
      db.close();
    }
  });
});
