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
 * E2E（issue #42）：版本对比在「单侧缺正文」时不得谎报内容变更。
 *
 * 场景（fixtures/e2e-versions-degraded，npc 源）：
 *   湿地保护法三轮 —— r1 有正文 → r2 有正文（可对比）→ r3 **本轮无正文**
 *   草原法三轮     —— r1 **无正文** → r2 有正文（上一轮无正文）→ r3 有正文（可对比）
 *   航道法单轮     —— 无上一版（空态回归）
 *
 * 修复前的行为：`diffNoticeBodies(上一版正文, 本轮空)` 会把上一版每个条款都输出成
 * 「删除」→ 页面上整篇「删除」，读者以为这一轮把草案全删了；而详情页同一时刻显示的
 * 是「正文未取到」。反向则整篇「新增」。空态只在两侧都空时出现，所以这种谎报完全静默。
 *
 * 本文件锁定的性质：
 * - 单侧缺正文 → 明确说明「哪一轮没取到」+ 不渲染任何差异行（尤其不出现「删除」「新增」徽标）；
 * - 两侧都有正文 → 三态对比照常（守卫不能误伤正常对比）；
 * - 对比页自己的 metadata（issue #42 附带）：标题含条目名、noindex + follow、
 *   且**不覆盖** layout 的 RSS 自动发现（issue #41 在首页踩过的坑）。
 *
 * 全程零外部依赖（ADR-0001）：SQLite 临时文件库 + 本地 fixture 源站 + stub LLM。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue42-'));
const dbFile = path.join(workDir, 'app.db');
const tempFixturesDir = path.join(workDir, 'fixtures');

const TITLES = {
  wetlandR1: '中华人民共和国湿地保护法（草案征求意见稿）征求意见',
  wetlandR2: '中华人民共和国湿地保护法（草案二次征求意见稿）征求意见',
  wetlandR3: '中华人民共和国湿地保护法（草案三次征求意见稿）征求意见',
  grassR1: '中华人民共和国草原法（修订草案一次征求意见稿）征求意见',
  grassR2: '中华人民共和国草原法（修订草案）征求意见',
  grassR3: '中华人民共和国草原法（修订草案二次征求意见稿）征求意见',
  canal: '中华人民共和国航道法（修订草案）征求意见',
};

let app;
let fixtures;

/** 单轮运行真实 worker 子进程（抓取 → 版本链关联 → 摘要 → 检索索引重建）。 */
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

/** 列表页 HTML → 标题对应的详情链接路径（/notices/<id>）。 */
function detailHrefOf(html, title) {
  const anchors = [...html.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)];
  const anchor = anchors.find(
    ([, attrs, text]) => attrs.includes('notice-title-link') && text.trim() === title,
  );
  assert.ok(anchor, `列表页应含条目「${title}」`);
  const href = /href="(\/notices\/[0-9a-f]+)"/.exec(anchor[1]);
  assert.ok(href, `条目「${title}」应有详情链接`);
  return href[1];
}

/** 取某条目对比页的 HTML（剥 SSR 注释）。 */
async function diffOf(title) {
  const list = await (await fetch(`${app.url}/`)).text();
  const href = detailHrefOf(list, title);
  const response = await fetch(`${app.url}${href}/diff`);
  assert.equal(response.status, 200, `${title} 的对比页应 200`);
  return stripSsrComments(await response.text());
}

before(async () => {
  fs.cpSync(
    path.join(repoRoot, 'fixtures', 'e2e-versions-degraded', 'npc'),
    path.join(tempFixturesDir, 'npc'),
    { recursive: true },
  );
  fixtures = createFixtureServer({ fixturesDir: tempFixturesDir });
  const fixtureUrl = (await fixtures.start()).url;

  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      SOURCES_FIXTURE_BASE: fixtureUrl,
      SITE_URL: 'https://zw.test',
    },
  });

  const run = await runWorkerOnce();
  assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('issue #42：版本对比的单侧缺正文', () => {
  it('版本链按发布日期串起两个法案（各三轮）', async () => {
    const list = await (await fetch(`${app.url}/`)).text();
    for (const title of Object.values(TITLES)) {
      assert.ok(detailHrefOf(list, title), `列表页应含「${title}」`);
    }
  });

  it('本轮缺正文：说明「本轮未取到」并给出上一轮入口，绝不渲染「删除」', async () => {
    const html = await diffOf(TITLES.wetlandR3);

    assert.match(html, /data-testid="diff-incomplete-body"/, '应渲染「缺正文」说明');
    assert.match(html, /本轮（第 3 轮）的正文未取到/, '要点明是哪一轮没取到');
    assert.match(html, /data-testid="diff-previous-body-link"/, '应给上一轮条目页入口');
    assert.ok(!/data-testid="diff-rows"/.test(html), '缺正文时不该渲染差异行');
    assert.ok(!/data-testid="diff-removed"/.test(html), '绝不能把上一版报成「删除」');
    assert.ok(!/data-testid="diff-added"/.test(html));
    assert.ok(!/data-testid="diff-no-body"/.test(html), '这不是「两轮都无正文」');
    // 轮次横幅仍然有效（两轮的对应关系是真的）
    assert.match(html, /data-testid="diff-version-banner"/);
  });

  it('上一轮缺正文：说明「上一轮未取到」并给出本轮入口，绝不渲染「新增」', async () => {
    const html = await diffOf(TITLES.grassR2);

    assert.match(html, /data-testid="diff-incomplete-body"/);
    assert.match(html, /上一轮的正文未取到/, '要点明是哪一轮没取到');
    assert.match(html, /data-testid="diff-current-body-link"/, '应给本轮条目页入口');
    assert.ok(!/data-testid="diff-rows"/.test(html));
    assert.ok(!/data-testid="diff-added"/.test(html), '绝不能把本轮报成「整篇新增」');
    assert.ok(!/data-testid="diff-removed"/.test(html));
  });

  it('两侧都有正文：三态对比照常（守卫不误伤）', async () => {
    for (const title of [TITLES.wetlandR2, TITLES.grassR3]) {
      const html = await diffOf(title);
      assert.match(html, /data-testid="diff-rows"/, `「${title}」应渲染差异行`);
      assert.ok(!/data-testid="diff-incomplete-body"/.test(html), '可比时不该出现缺正文说明');
      assert.ok(!/data-testid="diff-removed"/.test(html), '这两个链条没有被删除的条款');
      assert.ok(/data-testid="diff-added"/.test(html), '应含新增条款');
      assert.ok(/data-testid="diff-modified"/.test(html), '应含改写条款');
      assert.ok(/data-testid="diff-ins-new"/.test(html), '改写行应有行内新增片段');
    }
  });

  it('无上一版的条目仍是空态（原行为不变）', async () => {
    const html = await diffOf(TITLES.canal);
    assert.match(html, /data-testid="diff-empty"/);
    assert.ok(!/data-testid="diff-incomplete-body"/.test(html));
  });

  it('对比页有自己的 metadata：标题含条目名、noindex+follow、RSS 自动发现不被覆盖', async () => {
    const html = await diffOf(TITLES.wetlandR3);
    const head = html.slice(0, html.indexOf('</head>'));

    const title = /<title>([^<]*)<\/title>/.exec(head)?.[1] ?? '';
    assert.match(title, /^条款对比：/, `对比页标题应说明这是对比页，实际：${title}`);
    assert.ok(
      title.includes('湿地保护法'),
      `对比页标题应含条目标题（此前整页共用 layout 的通用标题），实际：${title}`,
    );
    assert.match(
      /<meta name="robots" content="([^"]*)"/.exec(head)?.[1] ?? '',
      /noindex/,
      '对比页正文是两版条目的并集，不该进索引',
    );
    assert.match(/<meta name="robots" content="([^"]*)"/.exec(head)?.[1] ?? '', /follow/);
    assert.ok(
      /<link[^>]*rel="alternate"[^>]*type="application\/rss\+xml"[^>]*>/.test(head),
      '对比页仍应保留 layout 的 RSS 自动发现（alternates 不能被覆盖）',
    );
  });
});
