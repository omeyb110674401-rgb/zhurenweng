import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { startAppServer } from './helpers/app-server.mjs';
import { createFixtureServer } from './helpers/fixture-server.mjs';
import { noticeIdForUrl } from '../../src/lib/notice-id.ts';

/**
 * E2E（issue #52）：抓取侧的信任边界 —— 源站能指挥 worker 去请求什么。
 *
 * 三条用例，共用一个手写的 cac 快照（5 条：3 条正常 + 2 条指向内网）：
 * 1. **出网守卫**：列表里的详情链接指向 `169.254.169.254`（云元数据）与一个
 *    「302 到 `100.100.100.200`」的地址 → 两跳都必须被守卫拒绝，**不能真的发请求**
 *    （断言日志里是守卫的理由，不是连接错误）；同时对照条目的正文照常抓到 ——
 *    守卫不能误伤正常抓取；
 * 2. **响应体上限（详情）**：把对照条目的详情页换成 5 MiB → 超限按详情失败降级，
 *    且**已入库的正文被保全**（#30 的保全机制对超限同样生效）；
 * 3. **响应体上限（列表）**：列表页超限 → 整源失败（源级告警路径）。
 *
 * 为什么这些是真问题：详情 URL 来自第三方页面（`extract.ts` 只看协议），重定向目标
 * 同样来自第三方；被挂马 / 改版的源站因此能把 worker 变成打内网的跳板，而正文还能
 * 以纯文本入库并公开渲染 —— 一条数据外带通道。上限则是防「异常源把 worker 内存打满」，
 * 而 worker 同时跑抓取 / 摘要 / 提醒，OOM 会中断整条数据管线。
 *
 * 全程零外部依赖（ADR-0001）：SQLite 临时库 + 本地 fixture 源站 + stub 邮件。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue52-'));
const fixturesDir = path.join(workDir, 'fixtures');
const dbFile = path.join(workDir, 'app.db');
const outboxFile = path.join(workDir, 'outbox.jsonl');

const META_IP = '169.254.169.254';
const ALIYUN_META_IP = '100.100.100.200';

/** 三条对照条目（详情快照会真的写到磁盘上）。 */
const CONTROLS = [
  {
    file: 'd1.htm',
    title: '国家互联网信息办公室关于《出网守卫对照办法（征求意见稿）》公开征求意见的通知',
    body: '对照条目正文一：这是第一条对照条目的正文，用来证明守卫没有误伤正常抓取。',
  },
  {
    file: 'd2.htm',
    title: '国家互联网信息办公室关于《出网守卫对照条例（征求意见稿）》公开征求意见的通知',
    body: '对照条目正文二。',
  },
  {
    file: 'd3.htm',
    title: '国家互联网信息办公室关于《出网守卫对照规定（征求意见稿）》公开征求意见的通知',
    body: '对照条目正文三。',
  },
];

/** 两条「恶意」条目：一条直连元数据地址，一条经源站 302 跳过去。 */
const BLOCKED_DIRECT = {
  title: '国家互联网信息办公室关于《出网守卫直连用例（征求意见稿）》公开征求意见的通知',
  href: `http://${META_IP}/latest/meta-data/`,
};
const BLOCKED_REDIRECT = {
  title: '国家互联网信息办公室关于《出网守卫重定向用例（征求意见稿）》公开征求意见的通知',
  href: `../__redirect?to=${encodeURIComponent(`http://${ALIYUN_META_IP}/latest/meta-data/`)}`,
};

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

/** cac 列表页（手写：结构对齐真实栏目页，见 src/sources/adapters/cac.ts 文件头）。 */
function listHtml(rows) {
  const items = rows
    .map(
      (row) =>
        `<li><h5><a href="${row.href}" target="_blank" title="${row.title}">${row.title}</a></h5>` +
        '<div class="times">{{DATE-2}}</div></li>',
    )
    .join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>网信@你</title></head>
<body><div class="main"><div id="loadingInfoPage" class="default">${items}</div></div></body></html>`;
}

/** cac 详情页（保留 h1.title / #pubtime / #BodyLabel 三个解析点）。 */
function detailHtml(title, body) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>
<body><div class="main-title"><h1 class="title">${title}</h1>
<div class="info clearfix"><span id="pubtime">{{CN_DATE-2}} 09:30</span></div></div>
<div class="main-content"><div id="BodyLabel"><p>${body}</p>
<p>意见反馈截止日期为{{CN_DATE+20}}。</p></div></div></body></html>`;
}

/** 写一份完整的 cac 快照（列表 5 条 + 3 个详情文件）。 */
function writeFixtures() {
  const cacDir = path.join(fixturesDir, 'cac');
  fs.mkdirSync(cacDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacDir, 'list.html'),
    listHtml([
      ...CONTROLS.map((control) => ({ href: control.file, title: control.title })),
      BLOCKED_DIRECT,
      BLOCKED_REDIRECT,
    ]),
  );
  for (const control of CONTROLS) {
    fs.writeFileSync(path.join(cacDir, control.file), detailHtml(control.title, control.body));
  }
}

/** 取某条目的详情页 HTML。 */
async function noticePage(url) {
  const response = await fetch(`${app.url}/notices/${noticeIdForUrl(url)}`);
  return { status: response.status, html: await response.text() };
}

before(async () => {
  writeFixtures();
  fixtures = createFixtureServer({ fixturesDir });
  fixtureUrl = (await fixtures.start()).url;

  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      MAILER_OUTBOX_FILE: outboxFile,
      FIXTURES_DIR: fixturesDir,
      SOURCES_FIXTURE_BASE: fixtureUrl,
      SITE_URL: 'https://zw.test',
      ALERT_EMAIL: 'ops@zhurenweng.example',
    },
  });
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('issue #52：抓取出网守卫与响应体上限', () => {
  it('第一轮：指向内网的详情链接被守卫拒绝（不发请求），正常条目不受影响', async () => {
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出：${run.output}`);

    // 5 条全部入库（被拦的两条以列表层数据入库，不整条丢弃）
    assert.match(
      run.output,
      /源 cac 抓取完成：列表 5 条，新增 5，更新 0，详情失败 2，入库失败 0/,
      `列表层数据必须保住：${run.output}`,
    );

    // 直连与重定向两条路径都被拦，且理由是「守卫」而不是连接错误
    assert.match(run.output, new RegExp(`出网守卫拒绝（目标指向内网 / 本机地址：${META_IP}）`));
    assert.match(
      run.output,
      new RegExp(`出网守卫拒绝（目标指向内网 / 本机地址：${ALIYUN_META_IP}）`),
      `重定向的每一跳都要过守卫：${run.output}`,
    );
    assert.ok(
      !/fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/.test(run.output),
      `被拦的地址不该真的发出请求：${run.output}`,
    );

    // 对照条目：正文照常抓到（守卫不误伤正常抓取）
    const control = await noticePage(`${fixtureUrl}/cac/d1.htm`);
    assert.equal(control.status, 200);
    assert.match(control.html, /对照条目正文一/, '正常条目的详情必须抓得到');

    // 被拦条目仍在（列表层数据），且详情层为空
    const blocked = await noticePage(`http://${META_IP}/latest/meta-data/`);
    assert.equal(blocked.status, 200, '被拦条目仍以列表层数据入库');
    assert.match(blocked.html, /出网守卫直连用例/);
    assert.ok(!blocked.html.includes('对照条目正文'), '被拦条目的正文不该有内容');

    // 2/5 失败不到降级线（见 lib/source-health.ts），不误报
    assert.ok(!/源 cac 数据质量降级/.test(run.output), `2/5 不该判降级：${run.output}`);
  });

  it('第二轮：详情页超限按详情失败降级，且已入库正文被保全', async () => {
    const cacDir = path.join(fixturesDir, 'cac');
    fs.writeFileSync(
      path.join(cacDir, 'd1.htm'),
      `<html><body><div id="BodyLabel"><p>${'x'.repeat(5 * 1024 * 1024)}</p></div></body></html>`,
    );

    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `超限不是崩溃：${run.output}`);
    assert.match(run.output, /响应体超过 4 MiB 上限/, `超限要说清原因：${run.output}`);
    assert.match(run.output, /详情失败 3，入库失败 0/, '超限计入详情失败');

    // 超限 → 本轮没拿到详情 → 沿用已入库的详情层字段（#30 的保全机制同样生效）
    const control = await noticePage(`${fixtureUrl}/cac/d1.htm`);
    assert.match(control.html, /对照条目正文一/, '超限不能抹掉上一轮抓到的正文');
  });

  it('第三轮：列表页超限 → 整源失败（走源级告警路径）', async () => {
    fs.writeFileSync(
      path.join(fixturesDir, 'cac', 'list.html'),
      `<html><body><div id="loadingInfoPage">${'x'.repeat(5 * 1024 * 1024)}</div></body></html>`,
    );

    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `源失败不中断整轮：${run.output}`);
    assert.match(run.output, /源 cac 抓取失败/, `列表超限按源级失败处理：${run.output}`);
    assert.match(run.output, /响应体超过 4 MiB 上限/);
  });
});
