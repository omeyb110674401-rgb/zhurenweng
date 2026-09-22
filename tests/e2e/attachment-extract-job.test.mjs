import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { URL } from 'node:url';

/**
 * 端到端（不出网）：extract-attachments 任务的整条链路（issue #57）。
 *
 * 这里覆盖的是**任务层**这件事（解析器本身在 tests/unit/attachment-parse.test.mjs）：
 * 同步清单 → 打分选附件 → 探测 → 下载 → 判型 → 解析 → 每个文件立刻写终态。
 * 四条最容易静默坏掉的事各有一条断言：
 *   1. 每类失败落到**不同**终态 —— 否则生产上分不出「源站拒绝」与「这文件读不了」；
 *   2. 打分与每条公示 3 个的上限真实生效：空白意见表**根本不该被下载**；
 *   3. 跨轮缓存命中：第二轮对已 ok 的文件不能再发请求 —— 这是「每轮 ≤120 个文件」
 *      这条礼貌预算成立的前提，也是 miit 那批 403 主机不被每天骚扰的保证；
 *   4. referer 与 Range 真的发出去了（referer 是 #57 唯一没被试过的一手）。
 *
 * 零外部依赖：临时 SQLite + 进程内 HTTP 服务，不起 web、不碰真实站点。
 */

const FIXTURE_DIR = path.resolve('fixtures/e2e-attachments');

/** 请求留痕（每轮清空，用于「有没有再发请求」这类断言）。 */
const requests = [];
/** URL 路径 → 要吐哪个夹具文件；null / 'denied' / 'gone' 是三种扮演失败的分支。 */
const ROUTES = {
  'draft.docx': 'draft.docx',
  'form.docx': 'blank-form.docx',
  'scan.pdf': 'scan-only.pdf',
  'denied.pdf': 'denied',
  'fake.pdf': null,
  'broken.doc': 'broken.doc',
  // 第四、五条公示复用同一批字节，只为了让打分与上限的判断有得比较
  'c1.pdf': 'scan-only.pdf',
  'c2.docx': 'draft.docx',
  'c3.docx': 'draft.docx',
  'c4.docx': 'blank-form.docx',
  'c5.png': 'scan-only.pdf',
};

let server;
let base;
let job;
let repo;
let logs;

function startServer() {
  return new Promise((resolve) => {
    const instance = createServer(async (request, response) => {
      const name = decodeURIComponent(new URL(request.url, 'http://x').pathname.slice(1));
      requests.push({ name, headers: request.headers });
      if (ROUTES[name] === 'denied') {
        response.writeHead(403, { 'content-type': 'text/html' });
        response.end('<!DOCTYPE html><html><body>403 Forbidden</body></html>');
        return;
      }
      if (ROUTES[name] === 'gone') {
        response.writeHead(404, { 'content-type': 'text/html' });
        response.end('<!DOCTYPE html><html><body>404</body></html>');
        return;
      }
      if (ROUTES[name] === null) {
        // 200 + HTML：URL 以 .pdf 结尾但给的是网页（miit 的 365cyd 拦截页就是这个形态）
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!DOCTYPE html><html><head><title>请验证后访问</title></head><body>x</body></html>');
        return;
      }
      const body = await readFile(path.join(FIXTURE_DIR, ROUTES[name] ?? name));
      // Range 要真的理：不然探测阶段推不出总大小，too_large 那条路永远走不到
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
      if (range !== null) {
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), body.length - 1);
        response.writeHead(206, {
          'content-type': 'application/octet-stream',
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${body.length}`,
        });
        response.end(body.subarray(start, end + 1));
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
      });
      response.end(body);
    });
    instance.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${instance.address().port}`;
      resolve(instance);
    });
  });
}

const urlOf = (name) => `${base}/${name}`;
const hitsFor = (name) => requests.filter((entry) => entry.name === name).length;

async function rowsOf(noticeId) {
  const rows = await repo.listNoticeAttachments(noticeId);
  return new Map(rows.map((row) => [row.url, row]));
}

async function seed(noticeId, attachments) {
  const { upsertNotice } = await import('../../src/db/repo/notices.ts');
  await upsertNotice({
    id: noticeId,
    sourceId: 'e2e-attachments',
    title: `附件抽取测试条目 ${noticeId}`,
    agency: '测试部',
    url: `${base}/detail-${noticeId}.html`,
    publishedAt: '2026-09-20',
    deadlineAt: '2026-10-07',
    status: 'open',
    bodyText: '现向社会公开征求意见。',
    attachments,
    fetchedAt: new Date().toISOString(),
  });
}

before(async () => {
  server = await startServer();
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-extract-job-'));
  process.env.DB_DRIVER = 'sqlite';
  process.env.DATABASE_URL = path.join(workDir, 'app.db');
  // 出网守卫默认拦环回地址；SOURCES_FIXTURE_BASE 是既有的放行口径（issue #52）
  process.env.SOURCES_FIXTURE_BASE = base;
  // 礼貌间隔在测试里不该真的等（另有断言钉它的作用）
  process.env.ATTACHMENT_HOST_INTERVAL_MS = '0';
  process.env.ATTACHMENT_EXCLUDE_SOURCES = '';

  // 客户端是进程内单例：env 就位之前不能 import（档位常量在模块顶层读）
  job = (await import('../../worker/jobs/extract-attachments.ts')).extractAttachmentsJob;
  repo = await import('../../src/db/repo/attachments.ts');
  const { upsertSource } = await import('../../src/db/repo/sources.ts');
  await upsertSource({
    id: 'e2e-attachments',
    name: '附件抽取测试源',
    adapterType: 'fixture',
    scheduleConfig: {},
  });

  // 三条公示分别服务三组断言：一条公示一轮最多下 3 个文件，混在一起就分不清是谁的功劳
  await seed('1'.repeat(32), [
    { name: '建筑市场信用管理办法（草案征求意见稿）.docx', url: urlOf('draft.docx') },
    { name: '意见征求表.docx', url: urlOf('form.docx') },
    { name: '标准文本（扫描版）.pdf', url: urlOf('scan.pdf') },
  ]);
  await seed('2'.repeat(32), [
    { name: '某办法规定.pdf', url: urlOf('denied.pdf') },
    { name: '正文.pdf', url: urlOf('fake.pdf') },
    { name: '办法正文.doc', url: urlOf('broken.doc') },
  ]);
  await seed('3'.repeat(32), [
    { name: '测试办法（草案征求意见稿）.pdf', url: urlOf('c1.pdf') },
    { name: '起草说明.docx', url: urlOf('c2.docx') },
    { name: '标准文本.docx', url: urlOf('c3.docx') },
    { name: '意见征求表.docx', url: urlOf('c4.docx') },
    { name: '附图.png', url: urlOf('c5.png') },
  ]);
  logs = [];
});

after(() => {
  server?.close();
});

const ctx = { logger: (message) => logs.push(message), now: () => new Date() };

describe('extract-attachments 单轮', () => {
  before(async () => {
    requests.length = 0;
    await job.run(ctx);
  });

  it('每类失败落到自己的终态', async () => {
    const rows = new Map([...(await rowsOf('1'.repeat(32))), ...(await rowsOf('2'.repeat(32)))]);
    /** 这几个终态长得很像，断言里带上 error 才能一眼看出是哪一步走岔了。 */
    const statusOf = (name) => {
      const row = rows.get(urlOf(name));
      return `${row?.status}（${row?.error ?? '无'}）`;
    };
    const expectStatus = (name, expected) =>
      assert.equal(rows.get(urlOf(name))?.status, expected, `${name} 实际是 ${statusOf(name)}`);

    expectStatus('draft.docx', 'ok');
    expectStatus('form.docx', 'no_draft_text');
    expectStatus('scan.pdf', 'scanned_no_text');
    expectStatus('denied.pdf', 'blocked');
    expectStatus('fake.pdf', 'not_a_file');
    expectStatus('broken.doc', 'unsupported_container');
  });

  it('ok 行存下逐字条文与**整档**的 sha256', async () => {
    const rows = await rowsOf('1'.repeat(32));
    const draft = rows.get(urlOf('draft.docx'));
    assert.ok(draft.extractedText.includes('第二条 适用范围'), '摘要要的正是这句');
    assert.ok(draft.charCount > 0);
    const bytes = await readFile(path.join(FIXTURE_DIR, 'draft.docx'));
    assert.equal(
      draft.contentHash,
      createHash('sha256').update(new Uint8Array(bytes)).digest('hex'),
      '哈希算在探测前缀上的话，两个不同文件会撞成同一个跨轮缓存键',
    );
  });

  it('空白意见表与图片根本不被下载（打分 + 每条 3 个的上限）', async () => {
    assert.equal(hitsFor('c4.docx'), 0, '意见征求表若被下载，等于把预算花在下划线上');
    assert.equal(hitsFor('c5.png'), 0, '图片不是条文载体');
    assert.ok(hitsFor('c1.pdf') >= 1 && hitsFor('c2.docx') >= 1, '排在前列的草案要真被取到');
    const rows = await rowsOf('3'.repeat(32));
    assert.equal(rows.get(urlOf('c4.docx')).status, 'pending', '没轮到的行要留在 pending，不能被写成终态');
  });

  it('附件请求带 referer 与 Range', () => {
    const probe = requests.find((entry) => entry.name === 'c1.pdf');
    assert.equal(probe.headers.referer, `${base}/detail-${'3'.repeat(32)}.html`);
    assert.match(probe.headers.range ?? '', /^bytes=0-\d+$/, '不带 Range 就得先整档下载才知道大小');
  });

  it('日志给出本轮的失败面，而不是只报成功', () => {
    const summary = logs.find((line) => line.includes('附件抽取'));
    assert.ok(summary !== undefined, `只有这些日志：${logs.join(' | ')}`);
    assert.match(summary, /blocked=/);
    assert.match(summary, /no_draft_text=/);
  });
});

describe('跨轮行为', () => {
  it('已 ok 的文件第二轮不再请求（刷新周期没到）', async () => {
    requests.length = 0;
    await job.run(ctx);
    assert.equal(hitsFor('draft.docx'), 0, '每轮重下一遍整档，礼貌预算与「每天 120 个文件」都白设');
  });

  it('刚记为 blocked 的行下一轮也不撞（退避按天数而不是按轮）', async () => {
    requests.length = 0;
    await job.run(ctx);
    assert.equal(
      hitsFor('denied.pdf'),
      0,
      'miit 那批整站 403 的主机如果每天被重试，就是每天 16 个无意义请求',
    );
    const rows = await rowsOf('2'.repeat(32));
    assert.ok(rows.get(urlOf('denied.pdf')).lastFetchAt !== null, 'blocked 要记住上次请求时间');
  });

  it('刷新失败不清空已有条文（源站今天不顺利不该让摘要退化）', async () => {
    // 让 draft.docx 变成「到期该刷新」但这次拿不到：改库里的 last_fetch_at 到 40 天前，
    // 再把该路径切成 403。
    const { getDb } = await import('../../src/db/client.ts');
    const { noticeAttachments } = await import('../../src/db/schema/sqlite.ts');
    const { and, eq } = await import('drizzle-orm');
    const db = await getDb();
    await db
      .update(noticeAttachments)
      .set({ status: 'ok', lastFetchAt: new Date(Date.now() - 40 * 86_400_000).toISOString() })
      .where(and(eq(noticeAttachments.noticeId, '1'.repeat(32)), eq(noticeAttachments.url, urlOf('form.docx'))));
    ROUTES['form.docx'] = 'denied';

    await job.run(ctx);
    const rows = await rowsOf('1'.repeat(32));
    const stale = rows.get(urlOf('form.docx'));
    assert.equal(stale.status, 'ok', '刷新失败把状态写成 blocked，摘要就再也读不到这份文本');
    assert.match(stale.error ?? '', /本轮未能刷新/, '但失败必须照实写在 error 里');
    ROUTES['form.docx'] = 'blank-form.docx';
  });
});
