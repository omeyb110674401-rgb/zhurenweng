import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { startAppServer } from './helpers/app-server.mjs';
import { createFixtureServer } from './helpers/fixture-server.mjs';
import { headOf, metaContent, noticeItems } from './helpers/html.mjs';

/**
 * E2E（issue #53）：站点图标、分享图与页面元数据。
 *
 * 背景：仓库里此前**没有任何图标与分享资产** —— 没有 favicon.ico / icon /
 * apple-icon / og 图 / manifest，也没有 theme-color。后果是浏览器标签页空白、
 * `/favicon.ico` 直接 404、分享到微信或微博的卡片没有图、加到主屏只有一个裸链接。
 *
 * 这里钉住四件事：
 *   1. 四个资产路由真的可用（状态码、content-type、PNG 魔数、体积下界）；
 *   2. head 里真的声明了它们（rel="icon" / apple-touch-icon / manifest / theme-color）；
 *   3. `og:image` 在**自定义了 openGraph 的页面**上也在 —— 这是本轮抓到的一个真缺陷：
 *      Next 的文件约定（`opengraph-image.tsx`）产出的图会被页面自己的 `openGraph`
 *      整块覆盖，统计页与详情页因此一直没有分享图；现在改成静态文件 + 显式声明。
 *   4. 补齐的页面元数据（/stats、/subscribe）带上 description 与正确的 og:url。
 *
 * 数据用三源 fixture 真实抓取一轮（只为详情页那条断言，其余都是无数据页面）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue53-brand-'));
const dbFile = path.join(workDir, 'app.db');

/** PNG 文件头魔数。 */
const PNG_MAGIC = '89504e470d0a1a0a';

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

before(async () => {
  fixtures = createFixtureServer({ fixturesDir });
  const fixtureUrl = (await fixtures.start()).url;

  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      FIXTURES_DIR: fixturesDir,
      SOURCES_FIXTURE_BASE: fixtureUrl,
      SITE_URL: 'https://zw.test',
      APP_BASE_URL: 'https://zw.test',
    },
  });

  const run = await runWorkerOnce();
  assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

/** 取回一个图片路由，断言状态 / content-type / PNG 魔数 / 体积下界（防空图）。 */
async function fetchPng(pathname, minBytes) {
  const response = await fetch(`${app.url}${pathname}`);
  assert.equal(response.status, 200, `${pathname} 应 200`);
  assert.match(response.headers.get('content-type') ?? '', /^image\/png/, `${pathname} 应是 PNG`);
  const buffer = Buffer.from(await response.arrayBuffer());
  assert.equal(buffer.subarray(0, 8).toString('hex'), PNG_MAGIC, `${pathname} 应是合法 PNG`);
  assert.ok(
    buffer.length >= minBytes,
    `${pathname} 只有 ${buffer.length} 字节，疑似空白图（下界 ${minBytes}）`,
  );
  return buffer;
}

describe('issue #53：站点图标、分享图与元数据', () => {
  it('favicon.ico 可用（Next 不会把 /favicon.ico 映射到 icon.svg，必须真有这个文件）', async () => {
    const response = await fetch(`${app.url}/favicon.ico`);
    assert.equal(response.status, 200, '/favicon.ico 不应 404');
    assert.match(
      response.headers.get('content-type') ?? '',
      /image\/(x-icon|vnd\.microsoft\.icon)/,
      '/favicon.ico 的 content-type 应是图标类型',
    );
    const buffer = Buffer.from(await response.arrayBuffer());
    // ICO 目录头：保留位 0、类型 1（图标）、图像数 ≥ 1
    assert.equal(buffer.readUInt16LE(0), 0, 'ICO 保留位应为 0');
    assert.equal(buffer.readUInt16LE(2), 1, 'ICO 类型应为 1（图标）');
    assert.ok(buffer.readUInt16LE(4) >= 1, 'ICO 至少应含一张图');
  });

  it('icon.svg 可用且是 SVG（浏览器标签页图标的主源）', async () => {
    const response = await fetch(`${app.url}/icon.svg`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /image\/svg\+xml/);
    assert.match(await response.text(), /<svg[^>]*viewBox="0 0 64 64"/);
  });

  it('apple-icon.png 与 og-image.png 是真实 PNG', async () => {
    await fetchPng('/apple-icon.png', 500);
    await fetchPng('/og-image.png', 3000);
  });

  it('manifest 可用，含名称、主题色、语言与图标', async () => {
    const response = await fetch(`${app.url}/manifest.webmanifest`);
    assert.equal(response.status, 200);
    const manifest = await response.json();
    assert.equal(manifest.short_name, '主人翁');
    assert.equal(manifest.theme_color, '#b45309');
    assert.equal(manifest.lang, 'zh-CN');
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'manifest 应声明图标');
  });

  it('首页 head 声明图标、manifest、主题色与分享图', async () => {
    const html = await (await fetch(`${app.url}/`)).text();
    const head = headOf(html);
    assert.match(head, /<link rel="icon"[^>]*href="\/icon\.svg/, '应有 SVG 图标');
    assert.match(head, /<link rel="apple-touch-icon"[^>]*href="\/apple-icon\.png/, '应有 iOS 主屏图标');
    assert.match(head, /<link rel="manifest" href="\/manifest\.webmanifest"/);
    assert.equal(metaContent(html, 'theme-color'), '#b45309');
    assert.match(head, /<meta property="og:image" content="[^"]*\/og-image\.png"/);
    assert.match(head, /<meta property="og:image:width" content="1200"/);
    assert.match(head, /<meta name="twitter:card" content="summary_large_image"/);
    assert.match(head, /<meta name="twitter:image" content="[^"]*\/og-image\.png"/);
  });

  it('自定义了 openGraph 的页面同样带分享图（此前被整块覆盖，统计页与详情页都没图）', async () => {
    const stats = await (await fetch(`${app.url}/stats`)).text();
    assert.match(
      headOf(stats),
      /<meta property="og:image" content="[^"]*\/og-image\.png"/,
      '统计页自定义了 openGraph，分享图仍应存在',
    );
    assert.match(headOf(stats), /<meta property="og:url" content="https:\/\/zw\.test\/stats"/);

    const home = await (await fetch(`${app.url}/`)).text();
    const noticeId = /href="(\/notices\/[0-9a-f]+)"/.exec(noticeItems(home)[0] ?? '')?.[1];
    assert.ok(noticeId, '首页应有条目（fixture 抓取未产出数据？）');
    const detail = await (await fetch(`${app.url}${noticeId}`)).text();
    assert.match(headOf(detail), /<meta property="og:image" content="[^"]*\/og-image\.png"/);
    assert.match(headOf(detail), /<meta property="og:type" content="article"/);
  });

  it('/stats 与 /subscribe 补齐 description 与 og:url（此前只有标题或完全继承站点标题）', async () => {
    const stats = await (await fetch(`${app.url}/stats`)).text();
    assert.match(stats, /<title>数据统计 —— 主人翁<\/title>/);
    const statsDescription = metaContent(stats, 'description');
    assert.ok(
      statsDescription !== null && statsDescription.includes('公示量月度趋势'),
      `统计页应有自己的描述，实际：${statsDescription}`,
    );

    const subscribe = await (await fetch(`${app.url}/subscribe`)).text();
    assert.match(subscribe, /<title>订阅截止提醒 —— 主人翁<\/title>/);
    const subscribeDescription = metaContent(subscribe, 'description');
    assert.ok(
      subscribeDescription !== null && subscribeDescription.includes('double opt-in'),
      `订阅页应有自己的描述，实际：${subscribeDescription}`,
    );
    assert.match(headOf(subscribe), /<meta property="og:url" content="https:\/\/zw\.test\/subscribe"/);
  });
});
