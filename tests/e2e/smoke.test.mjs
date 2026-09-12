import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { startAppServer } from './helpers/app-server.mjs';
import { createFixtureServer } from './helpers/fixture-server.mjs';

/**
 * 冒烟 E2E（issue #2）：从 HTTP 层驱动整个应用，全程零外部依赖（ADR-0001）。
 * - 应用：进程内启动 Next.js 生产构建（需先 `next build`，见 npm run e2e）；
 * - 数据库：一次性 SQLite 文件库（首次请求时自动应用迁移）；
 * - LLM / 邮件：stub 端口，经环境变量注入；
 * - fixture 源站：本地 HTTP 服务，按 fixtures/<source>/ 目录提供快照。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-'));

let app;
let fixtures;
let fixtureUrl;

before(async () => {
  fixtures = createFixtureServer({ fixturesDir });
  const started = await fixtures.start();
  fixtureUrl = started.url;

  app = await startAppServer({
    env: {
      DATABASE_URL: path.join(workDir, 'app.db'),
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      MAILER_OUTBOX_FILE: path.join(workDir, 'outbox.jsonl'),
      FIXTURES_DIR: fixturesDir,
    },
  });
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('冒烟：脚手架与端到端骨架', () => {
  it('首页返回 200，呈现「主人翁」品牌与公示列表空态', async () => {
    const response = await fetch(`${app.url}/`);
    assert.equal(response.status, 200);

    const html = await response.text();
    assert.match(html, /主人翁/, '页面应包含品牌文案「主人翁」');
    assert.match(html, /暂无公示条目/, '空库时首页应显示公示列表空态');
    assert.match(html, /发现 · 读懂 · 行动/, '页面应包含产品定位文案');
  });

  it('fixture 源站按目录提供快照页面，并对缺失与穿越请求返回错误', async () => {
    const ok = await fetch(`${fixtureUrl}/npc-law-drafts/list.html`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type') ?? '', /text\/html/);
    const html = await ok.text();
    assert.match(html, /fixture-marker: npc-law-drafts\/list\.html/);

    const missing = await fetch(`${fixtureUrl}/npc-law-drafts/no-such-page.html`);
    assert.equal(missing.status, 404);

    const traversal = await fetch(`${fixtureUrl}/..%2F..%2Fpackage.json`);
    assert.equal(traversal.status, 400, '路径穿越请求应被拒绝');
  });

  it('stub LLM / stub 邮件可通过环境变量注入，并返回固定结构化结果', async () => {
    const { createLlmPort, createMailerPort } = await import('../../src/lib/ports.ts');

    process.env.LLM_PROVIDER = 'stub';
    process.env.MAILER_PROVIDER = 'stub';
    process.env.MAILER_OUTBOX_FILE = path.join(workDir, 'outbox-smoke.jsonl');

    const llm = createLlmPort();
    assert.equal(llm.provider, 'stub');
    const summary = await llm.summarize({
      title: '中华人民共和国样本法（修订草案）征求意见',
      bodyText: 'fixture 占位正文',
      url: 'https://example.gov/sample',
    });
    assert.equal(typeof summary.what, 'string');
    assert.ok(Array.isArray(summary.keyPoints) && summary.keyPoints.length > 0);
    assert.equal(summary.deadline, '2026-12-31');
    assert.match(summary.howToComment, /官方/);

    const mailer = createMailerPort();
    assert.equal(mailer.provider, 'stub');
    await mailer.send({
      to: 'reader@example.com',
      subject: '【主人翁】截止提醒（stub）',
      text: '样本法草案将于 7 天后截止征求意见',
    });

    const lines = fs.readFileSync(process.env.MAILER_OUTBOX_FILE, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const captured = JSON.parse(lines[0]);
    assert.equal(captured.subject, '【主人翁】截止提醒（stub）');
    assert.match(captured.text, /官方|截止/);
  });
});
