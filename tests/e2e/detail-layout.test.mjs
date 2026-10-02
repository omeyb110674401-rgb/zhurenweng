import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { startAppServer } from './helpers/app-server.mjs';
import { createFixtureServer } from './helpers/fixture-server.mjs';
import { noticeItems, stripSsrComments } from './helpers/html.mjs';

/**
 * E2E：详情页两栏版式（2026-10-02 用户拍板的「变体 B」）。
 *
 * 这一组只钉**结构**，不钉像素 —— 断点、栅格列宽、行宽上限这类东西没有浏览器就
 * 看不见（本仓库的 e2e 是起真服务 + 抓 HTML 解析，没有浏览器），所以：
 *
 *   1. HTML 层：两栏的 DOM 关系（谁在谁里面、谁是栅格的直接子项）；
 *   2. 源码文本层：CSS 里确实写了断点与列位（仓库既有先例：`mobile-and-a11y.test.mjs`
 *      用源码文本钉 `globals.css` 的断点，`feed-intake-note.test.mjs` 钉 `.tsx` 接线）。
 *
 * 为什么值得单独存在（都是"不报错、只是不对"的错法）：
 *   - 右栏如果**另做一份 CTA**（而不是把 `.action-slot` 用 grid 摆到第二列），
 *     `data-testid="go-official-button"` 在 DOM 里就有两份：e2e 命中歧义（`<a>` 正则
 *     抓到哪一个取决于顺序），读屏也会把同一个按钮念两遍。所以"CTA 恰好一次"是硬断言；
 *   - 「分步提意指引」如果忘了从行动栏搬出来，它会挤在 320px 的窄栏里折成十几行，
 *     而**没有任何测试会红** —— 这里用"在不在主栏里"钉住；
 *   - 窄屏落回靠 `.detail-rail` 基础规则里的 `grid-column: 1; grid-row: 2`。若只给
 *     宽屏写 `grid-column: 2`，窄屏那一行依然生效，右栏会被摆进一个并不存在的第二列
 *     （不报错、只是错版），所以列位必须在**基础规则**里就有。
 *
 * 数据与端口：与其它 e2e 同一套（ADR-0001 零外部依赖）—— `fixtures/e2e-sources`
 * 快照 + 本地 fixture 源站 + stub LLM / 邮件端口 + 一次性 SQLite 文件库。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures', 'e2e-sources');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-detail-layout-'));
const dbFile = path.join(workDir, 'app.db');

let app;
let fixtures;

/** 单轮运行真实 worker 子进程（继承 process.env，含 startAppServer 注入的 fixture 源站）。 */
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

/** 读仓库内源文件（用于断点这类「没有浏览器就断言不了」的目标，见文件头）。 */
function readSource(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/** 取 `@media (min-width: 1000px) { … }` 整块（按大括号配对收，不受块内嵌套影响）。 */
function wideMediaBlock(css) {
  const at = css.indexOf('@media (min-width: 1000px)');
  assert.ok(at >= 0, 'globals.css 应有 ≥1000px 的宽屏断点（详情页两栏的开关）');
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(at, i + 1);
    }
  }
  throw new Error('宽屏断点没有闭合的大括号');
}

/** 取某条 CSS 规则声明的属性文本（`{` 起、第一个 `}` 止）。 */
function ruleBody(css, selector) {
  const at = css.indexOf(selector);
  assert.ok(at >= 0, `globals.css 应存在规则 ${selector}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  assert.ok(open > 0 && close > open, `${selector} 的规则块不完整`);
  return css.slice(open + 1, close);
}

/**
 * 从一个元素的开标签起、按同名标签配对，取出它的**整个元素**（含标签本身）。
 *
 * 为什么按标签名配对而不是找下一个 `</div>`：`.detail-grid` 里套着好几层 `div`，
 * 「第一个 `</div>`」会把它截断在主栏中间，于是"右栏在不在栅格里"这类断言全部失真。
 * 只用开/闭标签计数，不需要真正的 HTML 解析器（ADR-0001：e2e 零外部依赖）。
 */
function elementByClass(html, tag, className) {
  const open = new RegExp(`<${tag}\\b[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`).exec(html);
  assert.ok(open, `页面应存在 .${className}`);
  const from = open.index;
  let depth = 0;
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
  re.lastIndex = from;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    if (m[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) {
        return {
          tag: open[0],
          html: html.slice(from, m.index + m[0].length),
          inner: html.slice(open.index + open[0].length, m.index),
        };
      }
    } else {
      depth += 1;
    }
  }
  throw new Error(`.${className} 的开标签没有配对的 </${tag}>`);
}

/** 数 `data-testid="…"` 在整段 HTML 里出现几次（重复 = e2e 命中歧义 + 读屏念两遍）。 */
function testIdCount(html, testId) {
  return [...html.matchAll(new RegExp(`data-testid="${testId}"`, 'g'))].length;
}

/** 某段 HTML 里的**顶层** `div` 个数（用于确认栅格只有主栏与右栏两个直接子项）。 */
function topLevelDivCount(html) {
  const re = /<div\b|<\/div>/g;
  let depth = 0;
  let count = 0;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    if (m[0].startsWith('</')) depth -= 1;
    else {
      if (depth === 0) count += 1;
      depth += 1;
    }
  }
  return count;
}

/**
 * 取一条详情页，剥掉 React 混排插入的 `<!-- -->`。
 *
 * 按**标题**取而不是取列表第一条：断言里有一条「附件清单在主栏内」，而列表首条是
 * "截止最近的"，不保证有附件 —— 那种失败读起来像"版式坏了"，其实是数据换了。这条
 * （交通运输部公路法修正草案）在本 fixture 里同时有正文、附件与提交渠道，是能一次
 * 覆盖右栏四件套的条目（与 notice-brief.test.mjs 用的是同一条）。
 */
const LAYOUT_NOTICE_TITLE =
  '关于《中华人民共和国公路法（修正草案征求意见稿）》公开征求意见的通知';

async function fixtureDetailHtml() {
  const list = await (await fetch(`${app.url}/`)).text();
  for (const block of noticeItems(list)) {
    const anchor = /<a[^>]*notice-title-link[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/.exec(block);
    if (anchor && anchor[2].trim() === LAYOUT_NOTICE_TITLE) {
      const response = await fetch(`${app.url}${anchor[1]}`);
      assert.equal(response.status, 200, `GET ${anchor[1]} 应 200`);
      return stripSsrComments(await response.text());
    }
  }
  throw new Error(`列表页应含条目「${LAYOUT_NOTICE_TITLE}」`);
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
    },
  });

  const run = await runWorkerOnce();
  assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('详情页两栏：DOM 结构（谁在谁里面）', () => {
  it('栅格存在，主栏与右栏各恰好一个', async () => {
    const html = await fixtureDetailHtml();
    assert.match(html, /class="detail-grid"/, '详情页应有 .detail-grid');
    assert.equal(
      [...html.matchAll(/class="detail-main"/g)].length,
      1,
      '.detail-main 应恰好一个（两个主栏意味着有内容被复制了）',
    );
    assert.equal(
      [...html.matchAll(/class="[^"]*\bdetail-rail\b[^"]*"/g)].length,
      1,
      '.detail-rail 应恰好一个',
    );
  });

  it('右栏就是行动栏本身：同一个节点带两个类，而不是另做一份 DOM', async () => {
    const html = await fixtureDetailHtml();
    const rail = elementByClass(html, 'aside', 'detail-rail');
    assert.match(
      rail.tag,
      /class="action-slot detail-rail"|class="detail-rail action-slot"/,
      `右栏应就是 .action-slot 那个节点（实际开标签：${rail.tag}）`,
    );
    // 反证：右栏若另做一份 CTA，这里会数到 2 —— e2e 的正则会命中歧义，读屏也会读两遍
    assert.equal(testIdCount(html, 'go-official-button'), 1, 'CTA 在全页只能出现一次');
    assert.equal(testIdCount(rail.html, 'go-official-button'), 1, '右栏里应有那唯一一份 CTA');
  });

  it('主栏与右栏都是栅格的直接子项（否则列位根本不起作用）', async () => {
    const html = await fixtureDetailHtml();
    const grid = elementByClass(html, 'div', 'detail-grid');
    const main = elementByClass(grid.inner, 'div', 'detail-main');
    const rail = elementByClass(grid.inner, 'aside', 'detail-rail');
    /*
     * 数"栅格这一层有几个 div 子项"时**必须先把右栏抠掉**：`topLevelDivCount` 只按 `div`
     * 的嵌套算深度，而右栏是 `<aside>` —— 它里面那些 div（提交方式、点击小字）在这个
     * 算法眼里是"深度 0"，于是会把它们数成栅格的直接子项（实测数出 2）。
     * 这是 helper 的已知粗糙处，不是页面错了；抠掉右栏后它就只数主栏那一个。
     */
    assert.equal(
      topLevelDivCount(grid.inner.replace(rail.html, '')),
      1,
      '栅格的第一列应只有 .detail-main 一个 div 子项',
    );
    assert.match(grid.inner, /<aside\b[^>]*class="[^"]*\bdetail-rail\b[^"]*"/, '右栏应是栅格的子项');
    /*
     * **"右栏是栅格的直接子项"必须用"它不在主栏里面"来证**，不能只用上面那句
     * "右栏出现在栅格的子串里"：嵌在主栏内部时子串里当然也有它，于是页面明明被挤成
     * "760 容器里一列主栏、右栏退化成主栏中间的一段"，这条断言照样是绿的。
     * 2026-10-02 第一版就是这么翻的车（代理自证全绿、渲染出来才发现），
     * 所以这里把判据换成"把主栏整段抠掉之后，右栏还在栅格这一层"。
     */
    assert.ok(
      !main.inner.includes('detail-rail'),
      '右栏不许嵌在 .detail-main 里面 —— 那会让栅格只剩一个子项、右栏退化成主栏里的一段',
    );
    const gridWithoutMain = grid.inner.replace(main.html, '');
    assert.match(
      gridWithoutMain,
      /<aside\b[^>]*class="[^"]*\bdetail-rail\b[^"]*"/,
      '抠掉主栏之后右栏仍应留在栅格这一层（这才叫"直接子项"）',
    );
    // 阅读顺序：主栏在右栏之前（窄屏单栏时右栏接在主栏之后，靠的就是这个顺序）
    assert.ok(main.html.length > 0 && rail.html.length > 0);
    assert.ok(
      grid.inner.indexOf('detail-main') < grid.inner.indexOf('detail-rail'),
      'DOM 里主栏应排在右栏之前',
    );
  });

  it('「分步提意指引」在主栏里，不在右栏里', async () => {
    const html = await fixtureDetailHtml();
    const grid = elementByClass(html, 'div', 'detail-grid');
    const main = elementByClass(grid.inner, 'div', 'detail-main');
    const rail = elementByClass(grid.inner, 'aside', 'detail-rail');
    assert.equal(testIdCount(html, 'how-to-comment'), 1, '提意指引全页只能有一份');
    assert.match(main.inner, /data-testid="how-to-comment"/, '提意指引应在主栏内');
    assert.ok(
      !rail.inner.includes('data-testid="how-to-comment"'),
      '提意指引不该留在 320px 的右栏里（会被折成十几行）',
    );
    // 摘要卡之后：有 AI 摘要时看摘要卡，没有时看结构化速读卡（两者互斥）
    const summaryAt = Math.max(main.inner.indexOf('ai-summary'), main.inner.indexOf('notice-brief'));
    assert.ok(summaryAt >= 0, '主栏里应有摘要卡或结构化速读卡');
    assert.ok(summaryAt < main.inner.indexOf('how-to-comment'), '提意指引应排在摘要卡之后');
  });

  it('右栏只留行动那几件（CTA / 提交方式 / 订阅提醒 / 出站点击）', async () => {
    const html = await fixtureDetailHtml();
    const rail = elementByClass(html, 'aside', 'detail-rail');
    assert.match(rail.html, /data-testid="go-official-button"/, 'CTA');
    assert.match(
      rail.html,
      /data-testid="submission-channels"|data-testid="submission-channels-empty"/,
      '意见提交方式（有渠道、或「为什么没取到」的说明，两者必居其一）',
    );
    assert.match(rail.html, /data-testid="outbound-clicks"/, '出站提意点击小字');
    // 订阅提醒入口按邮件端口门控（本套 fixture 是 stub 端口，所以它可见）
    assert.match(rail.html, /data-testid="subscribe-detail-link"/, '订阅提醒应在右栏');
  });

  it('正文与附件仍在主栏（宽屏下不跟着右栏浮起来）', async () => {
    const html = await fixtureDetailHtml();
    const grid = elementByClass(html, 'div', 'detail-grid');
    const main = elementByClass(grid.inner, 'div', 'detail-main');
    assert.match(main.inner, /data-testid="notice-body"/, '正文应在主栏内');
    assert.match(main.inner, /class="attachments"/, '附件清单应在主栏内');
  });
});

describe('详情页两栏：断点与栅格（源码文本，没有浏览器时的唯一办法）', () => {
  it('CSS 里写了 1000px 断点，窄屏基础规则是单列', () => {
    const css = readSource('src/app/globals.css');
    const base = ruleBody(css, '.detail-grid {');
    assert.match(base, /grid-template-columns: minmax\(0, 1fr\);/, '基础（窄屏）栅格应是单列');
    assert.match(base, /display:\s*grid/, '栅格布局写在基础规则里（宽屏只是换列数，不是从无到有）');
    assert.match(
      wideMediaBlock(css),
      /grid-template-columns:\s*minmax\(0, 1fr\) 320px/,
      '宽屏应是主栏 + 320px 右栏',
    );
  });

  it('右栏基础规则就写死第一列第二行 —— 窄屏落回原位，而不是被摆到不存在的第二列', () => {
    const css = readSource('src/app/globals.css');
    const base = ruleBody(css, '.detail-rail {');
    assert.match(base, /grid-column:\s*1/, '窄屏右栏应回到第一列');
    assert.match(base, /grid-row:\s*2/, '窄屏右栏应排在主栏之后（原位：摘要卡之后）');
    assert.doesNotMatch(base, /position:\s*(sticky|fixed|absolute)/, '窄屏右栏不能是 sticky');
  });

  it('sticky 只在 ≥1000px 生效，吸顶 16px 且不拉伸', () => {
    const wide = wideMediaBlock(readSource('src/app/globals.css'));
    const rail = ruleBody(wide, '.detail-rail {');
    assert.match(rail, /grid-column:\s*2/, '宽屏右栏应在第二列');
    assert.match(rail, /grid-row:\s*1/, '宽屏右栏应与主栏同一行（否则会被顶到主栏下面）');
    assert.match(rail, /position:\s*sticky/, '宽屏右栏应吸顶');
    assert.match(rail, /top:\s*16px/, '吸顶偏移 16px（与 mockup 一致）');
    assert.match(rail, /align-self:\s*start/, '不拉伸：右栏高度应由内容决定');
  });

  it('窄屏保持 760px 居中；页面只在宽屏变宽，且加宽与两栏绑在同一个选择器上', () => {
    const css = readSource('src/app/globals.css');
    // 基础 `.page` 没动：窄屏仍是 760px 居中（详情页只是多挂一个 detail-page 类）
    const page = ruleBody(css, '.page {');
    assert.match(page, /max-width:\s*760px/, '窄屏仍是 760px 居中');
    const wide = wideMediaBlock(css);
    /*
     * 加宽必须作用在**外层** `.page` 上：根布局把每一页都包在 `<div class="page">` 里
     * （layout.tsx），详情页的 `<main class="page detail-page">` 只是它的**子元素** ——
     * 子元素的 max-width 再大也压不过父容器的 760px。
     * 第一版写成 `main.page.detail-page { max-width: 1120px }`（看着特异性更高），
     * 后果是"栅格确实两列了、整页仍被关在 760px 里"，主栏只剩 372px。
     */
    /*
     * 2026-10-02 收尾：宽度从**断点里**搬到了**基础规则**上，而且写成连续式
     * `min(1120px, max(760px, 100% - 48px))`。原来它写死在断点里，视口跨过 1000px 时
     * 宽度从 760 一步跳到 952（拖窗口时看得见）。所以这里断言两件事：
     * ① 上限作用在**外层** `.page:has(.detail-grid)` 上（不是详情页自己的 `<main>`）；
     * ② 它是**连续式**（含 `min` 与百分比）—— 写死一个 px 就又会跳一次。
     */
    const widened = ruleBody(css, '.page:has(.detail-grid) {');
    assert.match(widened, /max-width:\s*min\(\s*1120px/, '上限放到 1120px，且作用在外层 .page 上');
    assert.match(widened, /100vw/, '上限必须是连续式（视口单位）：写死 px 会在断点处跳一次');
    assert.doesNotMatch(
      wide,
      /max-width/,
      '断点那一档里不许再写宽度 —— 写了会盖掉上面那条连续式，跳变就回来了',
    );
    assert.doesNotMatch(
      wide,
      /main\.page\.detail-page\s*\{[^}]*max-width/,
      '不许把宽度写在详情页自己的 <main> 上 —— 那是子元素，压不过父容器',
    );
    /*
     * 两栏切换必须与加宽绑在**同一个** `:has()` 上：不支持 `:has()` 的浏览器两条都不生效，
     * 页面与改动前逐字一致；若只门控加宽、两栏另写一条独立规则，降级形态就是
     * "760px 容器里硬塞两列"那种挤扁的错版 —— 比不支持更坏。
     */
    assert.match(
      wide,
      /\.page:has\(\.detail-grid\)\s+\.detail-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 320px/,
      '两栏切换要挂在同一个 :has() 上（降级必须安全）',
    );
    assert.doesNotMatch(
      wide,
      /(^|\n)\s*\.detail-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 320px/,
      '两栏不许写成不依赖 :has() 的独立规则',
    );
    assert.doesNotMatch(
      ruleBody(css, '.detail-page {'),
      /max-width/,
      '基础规则里不许写宽度 —— 那会连窄屏一起放宽，把「与现在一致」破坏掉',
    );
  });

  it('正文行宽上限 44em：加宽版式不许把正文行拉长', () => {
    const css = readSource('src/app/globals.css');
    assert.match(
      ruleBody(css, '.summary-section-text {'),
      /max-inline-size:\s*44em/,
      '摘要各段正文应有行宽上限',
    );
    assert.match(
      ruleBody(css, '.body-text {'),
      /max-inline-size:\s*44em/,
      '官方原文正文应有行宽上限',
    );
  });
});
