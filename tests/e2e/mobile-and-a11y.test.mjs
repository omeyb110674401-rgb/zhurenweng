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
 * E2E（issue #53）：移动端可用性与可达性。
 *
 * 背景：全站此前 **0 条媒体查询**、0 个跳转主内容链接、0 处 `aria-disabled`，
 * 而且越界页码的内容虽被夹到末页、地址栏与 canonical 却还停在越界地址。
 * 这一组断言分四块：
 *   1. **跳转主内容**：每个页面都有 skip link，且它指向的 `#main-content` 真的存在
 *      （只加链接不加 id 是最常见的半成品）；顺带钉住「每页恰好一个 h1」。
 *   2. **移动端**：globals.css 里真的有断点（详情字段单列、公示期分布换行、触控目标），
 *      后台宽表有横滚容器。
 *   3. **状态与死路**：禁用分页带 `aria-disabled`、越界页码 307 归一、
 *      `/go` 找不到条目时给读者一个能读的页面而不是裸 JSON。
 *   4. **表单回填**：校验失败后邮箱与关键词仍留在表单里（草稿 cookie）。
 *
 * 数据用三源 fixture 真实抓取一轮（与分页场景同一套），`LIST_PAGE_SIZE=3` 把 9 条
 * 切成 3 页，以便验证禁用分页与越界归一。全程零外部依赖（ADR-0001）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue53-mobile-'));
const dbFile = path.join(workDir, 'app.db');

const PAGE_SIZE = 3;
const ADMIN_TOKEN = 'zw-e2e-admin-token';

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

/** 取页面文本，顺带断言状态码。 */
async function getHtml(pathname, expectedStatus = 200) {
  const response = await fetch(`${app.url}${pathname}`);
  assert.equal(response.status, expectedStatus, `GET ${pathname} 应 ${expectedStatus}`);
  return response.text();
}

/** 取某 testid 元素的整个开标签（属性顺序不定，故先圈标签再查属性）。 */
function tagOf(html, testId) {
  return new RegExp(`<[a-z]+\\b[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? null;
}

/** 读仓库内源文件（用于 CSS 与渲染器这类「没有可用 fixture 直接断言」的目标）。 */
function readSource(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
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
      APP_BASE_URL: 'https://zw.test',
      ADMIN_TOKEN,
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

describe('issue #53：跳转主内容与标题层级', () => {
  it('每个页面都有 skip link，且 #main-content 真的存在', async () => {
    const firstNotice = await getHtml('/');
    const noticeId = /href="(\/notices\/[0-9a-f]+)"/.exec(noticeItems(firstNotice)[0] ?? '')?.[1];
    assert.ok(noticeId, '首页应有条目（fixture 抓取未产出数据？）');

    const pages = [
      ['/', 200],
      ['/search?q=征求意见', 200],
      ['/stats', 200],
      ['/subscribe', 200],
      [noticeId, 200],
      ['/no-such-page-e2e', 404],
    ];
    for (const [pathname, status] of pages) {
      const html = await getHtml(pathname, status);
      const skip = /<a class="skip-link"[^>]*href="#main-content"/.exec(html);
      assert.ok(skip, `${pathname} 应有跳转主内容链接`);
      assert.match(html, /<main[^>]*id="main-content"/, `${pathname} 的 #main-content 目标应存在`);
    }
  });

  it('每个页面恰好一个 h1（此前 /search 完全没有 h1）', async () => {
    for (const pathname of ['/', '/search?q=征求意见', '/stats', '/subscribe', '/no-such-page-e2e']) {
      const html = await getHtml(pathname, pathname === '/no-such-page-e2e' ? 404 : 200);
      const headings = html.match(/<h1\b/g) ?? [];
      assert.equal(headings.length, 1, `${pathname} 应恰好一个 h1，实际 ${headings.length} 个`);
    }
  });

  it('搜索页的面包屑是导航地标（此前是 <p>，与其它页不一致）', async () => {
    const html = await getHtml('/search?q=征求意见');
    assert.match(html, /<nav class="breadcrumb">/, '面包屑应是 nav');
    assert.ok(!html.includes('<p class="breadcrumb">'), '不应再是段落');
    assert.match(html, /<h1 class="brand">站内搜索<\/h1>/);
  });

  it('摘要区的标题是 h2 而不是 h3（h1 之下不再跳级）', () => {
    // 为什么读源码：fixture 不产出 AI 摘要（LLM 走 stub），详情页渲染的是
    // 「结构化速读 + 未启用说明」，这段 h2 在 e2e 里没有可渲染的数据路径。
    const source = readSource('src/app/_lib/summary-view.tsx');
    assert.match(source, /<h2 className="summary-section-title">/, '摘要分节标题应是 h2');
    assert.ok(!/<h3/.test(source), '不应再有 h3（会与 h1 之间跳级）');
  });

  it('首页的排序说明与订阅入口拆成独立一行，RSS 入口仍在其中', async () => {
    const html = await getHtml('/');
    const actions = /<p class="list-actions">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
    assert.ok(actions.length > 0, '首页应有 list-actions 行');
    assert.match(actions, /data-testid="rss-feed-link"/, 'RSS 入口应在这行里');
    assert.match(actions, /按征求意见截止日期排序/, '排序说明应在这行里');
  });
});

describe('issue #53：移动端断点与触控目标', () => {
  it('globals.css 里有首批媒体查询（详情字段单列 / 公示期分布换行 / 触控目标）', () => {
    const css = readSource('src/app/globals.css');
    assert.match(
      css,
      /@media \(max-width: 560px\) \{[\s\S]*?\.detail-fields \{[\s\S]*?grid-template-columns: 1fr/,
      '窄屏下详情字段应改为单列',
    );
    assert.match(
      css,
      /@media \(max-width: 420px\) \{[\s\S]*?\.period-buckets li \{[\s\S]*?flex-wrap: wrap/,
      '极窄屏下公示期分布应换行而不是撑破卡片',
    );
    assert.match(
      css,
      /@media \(pointer: coarse\) \{[\s\S]*?\.category-chip[\s\S]*?min-height: 40px/,
      '触控设备上筛选 chip 等目标应放大',
    );
  });

  it('.go-button 同时覆盖链接与按钮两种元素（订阅页的提交按钮此前带 UA 边框、光标是箭头）', () => {
    const css = readSource('src/app/globals.css');
    const block = /\.go-button \{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
    assert.ok(block.length > 0, '应存在 .go-button 规则');
    for (const declaration of ['border: none', 'cursor: pointer', 'font-family: inherit']) {
      assert.ok(block.includes(declaration), `.go-button 应声明 ${declaration}`);
    }
  });

  it('后台源健康看板的宽表包在横滚容器里，后台文档也有跳转主内容', async () => {
    const login = await fetch(`${app.url}/admin/login`, {
      method: 'POST',
      body: new URLSearchParams({ token: ADMIN_TOKEN }),
      redirect: 'manual',
    });
    assert.equal(login.status, 303);
    const cookie = login.headers
      .getSetCookie()
      .find((value) => value.startsWith('zw_admin_session='))
      ?.split(';')[0];
    assert.ok(cookie, '登录应下发会话 Cookie');

    const response = await fetch(`${app.url}/admin`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<a class="skip-link"[^>]*href="#main-content"/, '后台应有跳转主内容');
    assert.match(html, /<main id="main-content" data-testid="admin-dashboard">/);
    const wrapIndex = html.indexOf('<div class="table-wrap">');
    const tableIndex = html.indexOf('data-testid="source-health-board"');
    assert.ok(wrapIndex > 0, '源表应有横滚容器');
    assert.ok(tableIndex > wrapIndex, '横滚容器应包在表格之前');
  });
});

describe('issue #53：状态、死路与表单回填', () => {
  it('禁用分页带 aria-disabled（读屏此前会念出「上一页」却不说明不可用）', async () => {
    const first = await getHtml('/');
    const prevDisabled = tagOf(first, 'pagination-prev-disabled');
    assert.ok(prevDisabled, '首页应有禁用态的上一页');
    assert.match(prevDisabled, /aria-disabled="true"/);

    const last = await getHtml('/?page=3');
    const nextDisabled = tagOf(last, 'pagination-next-disabled');
    assert.ok(nextDisabled, '末页应有禁用态的下一页');
    assert.match(nextDisabled, /aria-disabled="true"/);
  });

  it('越界页码 307 归一：地址栏与 canonical 不再停在越界地址', async () => {
    const response = await fetch(`${app.url}/?page=999`, { redirect: 'manual' });
    assert.equal(response.status, 307, '越界页码应临时重定向到夹取后的地址');
    assert.match(response.headers.get('location') ?? '', /page=3$/, '应指向夹取后的末页');

    // 跟随重定向后仍是末页内容（既有分页断言的前提不能被打破）
    const followed = await fetch(`${app.url}/?page=999`);
    assert.equal(followed.status, 200);
    assert.match(await followed.text(), /第 3 \/ 3 页/);
  });

  it('/go 找不到条目时给读者一个能读的页面，而不是裸 JSON', async () => {
    const response = await fetch(`${app.url}/go/0000000000000000`, { redirect: 'manual' });
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/, '计数端点仍不可缓存');
    const html = await response.text();
    assert.match(html, /未找到该公示条目/);
    assert.match(html, /返回公示列表/, '应给出回站路径');
    assert.ok(!html.includes('{"error"'), '不应再回裸 JSON');
  });

  it('订阅校验失败后回填已填内容（草稿 cookie，邮箱不进 URL）', async () => {
    // 邮箱非法 + 关键词已填：校验按顺序先拦邮箱，因此这一次不会写库、不会发信，
    // 而草稿里两样都在 —— 正好验证「原样还给他」而不是「只还一部分」
    const posted = await fetch(`${app.url}/api/subscriptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'not-an-email', keywords: '噪声污染防治' }),
      redirect: 'manual',
    });
    assert.equal(posted.status, 303);
    assert.match(posted.headers.get('location') ?? '', /error=invalid_email/);
    const setCookie = posted.headers
      .getSetCookie()
      .find((value) => value.startsWith('subscribe_draft='));
    assert.ok(setCookie, '失败时应下发草稿 cookie');
    assert.match(setCookie, /HttpOnly/, '草稿 cookie 应为 HttpOnly');
    assert.match(setCookie, /Path=\/subscribe/, '草稿 cookie 应只作用于订阅页');
    assert.ok(
      !/Secure/.test(setCookie),
      '草稿 cookie 不能带 Secure —— 本地与 e2e 都跑在 http 上，带上浏览器根本不写',
    );
    assert.ok(
      !posted.headers.get('location')?.includes('not-an-email'),
      '邮箱不得出现在 Location 里',
    );

    const withDraft = await fetch(`${app.url}/subscribe?error=invalid_email`, {
      headers: { cookie: setCookie.split(';')[0] },
    });
    const html = await withDraft.text();
    const emailTag = tagOf(html, 'subscribe-email');
    const keywordsTag = tagOf(html, 'subscribe-keywords');
    assert.match(emailTag ?? '', /value="not-an-email"/, '邮箱应原样回填');
    assert.match(keywordsTag ?? '', /value="噪声污染防治"/, '关键词应回填');
    assert.match(html, /已保留你上次填写的内容/, '应说明内容已保留');

    // 反向断言：没有草稿 cookie 时表单是空的（草稿只随错误响应回来）
    const plain = await getHtml('/subscribe?error=invalid_email');
    assert.ok(!plain.includes('not-an-email'), '不带草稿时不应出现上一次的输入');
  });
});
