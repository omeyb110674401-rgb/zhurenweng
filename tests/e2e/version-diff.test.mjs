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
 * E2E（issue #10）：版本历史采集与新旧条款对比视图。
 *
 * 场景（抓取 → 版本关联 → 对比视图）：
 *   fixture 两轮公示（《湿地保护法》草案征求意见稿 / 草案二次征求意见稿，
 *   标题措辞不同、正文有增删改）+ 一条无关单轮条目（《航道法》）
 *   → worker 单轮抓取入库，版本链自动关联（标题规范化 + 同机关）
 *   → 第 2 轮详情页出现「对比上一版」入口与轮次提示
 *   → 第 1 轮 / 无关条目详情页不显示对比入口
 *   → /notices/<id>/diff 对比视图：横幅「这是第 2 轮征求意见稿，与上一轮
 *     （2026-08-20）对比」+ 新增 / 删除 / 修改三态高亮至少各一处，
 *     修改行含行内删除 / 新增片段 + 指向上一版的链接
 *   → 无上一版的条目访问对比视图得到友好空态
 *   → 重复抓取幂等：版本链关联不漂移
 *
 * 全程零外部依赖（ADR-0001）：SQLite 临时文件库 + 本地 fixture 源站 + stub LLM。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue10-'));
const dbFile = path.join(workDir, 'app.db');
const tempFixturesDir = path.join(workDir, 'fixtures');

const TITLES = {
  round1: '中华人民共和国湿地保护法（草案征求意见稿）征求意见',
  round2: '中华人民共和国湿地保护法（草案二次征求意见稿）征求意见',
  standalone: '中华人民共和国航道法（修订草案）征求意见',
};
/** 首轮（上一轮）公示的发布日期：版本链按发布日期定序，横幅文案断言用 */
const ROUND1_PUBLISHED_AT = '2026-08-20';
/** 仅存在于第二轮正文的新增条款 / 仅存在于首轮正文被删条款的特征词 */
const ADDED_CLAUSE_MARK = '湿地面积总量管控制度';
const REMOVED_CLAUSE_MARK = '保护优先、严格管理、系统治理';
const REWRITE_DEL_MARK = '及生物多样性';
const REWRITE_INS_MARK = '推进生态文明建设';

let app;
let fixtures;
let fixtureUrl;

/** 单轮运行真实 worker 子进程（抓取 → 摘要 → 提醒 → 检索索引重建）。 */
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

/** React SSR 会在文本 + 表达式混排处插入 <!-- --> 注释，文本断言前剥掉。 */
function stripSsrComments(html) {
  return html.replaceAll('<!-- -->', '');
}

/** 从列表页 HTML 按标题提取条目详情链接路径（/notices/<id>，不依赖属性顺序）。 */
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

before(async () => {
  // 测试私有 fixture 副本：本场景独立于仓库其他 fixture 集（ADR-0001 零外部依赖）
  fs.cpSync(path.join(repoRoot, 'fixtures', 'e2e-versions', 'npc'), path.join(tempFixturesDir, 'npc'), {
    recursive: true,
  });

  fixtures = createFixtureServer({ fixturesDir: tempFixturesDir });
  fixtureUrl = (await fixtures.start()).url;

  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      SOURCES_FIXTURE_BASE: fixtureUrl,
    },
  });
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('issue #10：版本链关联 → 对比视图（新增/删除/修改三态高亮）', () => {
  it('worker 单轮抓取：两轮公示与无关条目入库', async () => {
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /源 npc 抓取完成：列表 3 条，新增 3，更新 0/);

    const html = await (await fetch(`${app.url}/`)).text();
    for (const title of Object.values(TITLES)) {
      assert.match(html, new RegExp(title), `列表页应含条目「${title}」`);
    }
  });

  it('版本关联：第 2 轮详情页提供「对比上一版」入口，首轮与无关条目不显示', async () => {
    const listHtml = await (await fetch(`${app.url}/`)).text();
    const round1Href = detailHrefOf(listHtml, TITLES.round1);
    const round2Href = detailHrefOf(listHtml, TITLES.round2);
    const standaloneHref = detailHrefOf(listHtml, TITLES.standalone);

    const round2 = stripSsrComments(await (await fetch(`${app.url}${round2Href}`)).text());
    assert.match(round2, /data-testid="version-line"/, '第 2 轮详情页应有版本提示');
    assert.match(round2, /这是第 2 轮公示/, '版本提示应标明轮次序号');
    assert.match(round2, /data-testid="compare-previous-link"/, '应有「对比上一版」入口');
    assert.match(round2, /href="\/notices\/[0-9a-f]+\/diff"/, '入口应指向对比视图');

    const round1 = await (await fetch(`${app.url}${round1Href}`)).text();
    assert.ok(!round1.includes('compare-previous-link'), '首轮详情页不应有对比入口');
    assert.ok(!round1.includes('version-line'), '首轮详情页不应有版本提示');

    const standalone = await (await fetch(`${app.url}${standaloneHref}`)).text();
    assert.ok(!standalone.includes('compare-previous-link'), '无关单轮条目不应有对比入口');
  });

  it('对比视图：轮次横幅 + 新增/删除/修改三态高亮至少各一处 + 上一版链接', async () => {
    const listHtml = await (await fetch(`${app.url}/`)).text();
    const round1Href = detailHrefOf(listHtml, TITLES.round1);
    const round2Href = detailHrefOf(listHtml, TITLES.round2);

    const response = await fetch(`${app.url}${round2Href}/diff`);
    assert.equal(response.status, 200);
    const html = stripSsrComments(await response.text());

    // 显著轮次横幅：第 N 轮 + 上一轮发布日期
    assert.match(
      html,
      new RegExp(`这是第 2 轮征求意见稿，与上一轮（${ROUND1_PUBLISHED_AT}）对比`),
      '应有显著的轮次与上一轮日期提示',
    );
    // 指向上一版的链接
    assert.match(
      html,
      new RegExp(`data-testid="diff-previous-link"[^>]*href="${round1Href}"|href="${round1Href}"[^>]*data-testid="diff-previous-link"`),
      '应有指向上一版详情页的链接',
    );

    // 三态高亮至少各一处
    assert.match(html, /data-testid="diff-added"/, '应有新增条款高亮');
    assert.match(html, /data-testid="diff-removed"/, '应有删除条款高亮');
    assert.match(html, /data-testid="diff-modified"/, '应有修改条款高亮');

    // 新增 / 删除内容正确
    const addedRow = /<div[^>]*data-testid="diff-added"[\s\S]*?<\/div>/.exec(html)[0];
    assert.ok(
      addedRow.includes(ADDED_CLAUSE_MARK),
      `新增行应含第二轮新增条款内容，实际：${addedRow.slice(0, 200)}`,
    );
    assert.ok(addedRow.includes('新增'), '新增行应带「新增」标记');
    const removedRow = /<div[^>]*data-testid="diff-removed"[\s\S]*?<\/div>/.exec(html)[0];
    assert.ok(
      removedRow.includes(REMOVED_CLAUSE_MARK),
      `删除行应含首轮独有的条款内容，实际：${removedRow.slice(0, 200)}`,
    );
    assert.ok(removedRow.includes('删除'), '删除行应带「删除」标记');

    // 修改条款：行内删除 / 新增片段（字符级高亮）
    const modifiedRow = /<div[^>]*data-testid="diff-modified"[\s\S]*?<\/div>\s*<\/div>/.exec(html);
    assert.ok(modifiedRow, '修改行应含旧 / 新双行');
    assert.match(modifiedRow[0], /<del[^>]*class="diff-del"/, '修改行应有删除片段高亮');
    assert.match(modifiedRow[0], /<ins[^>]*class="diff-ins"/, '修改行应有新增片段高亮');
    assert.ok(modifiedRow[0].includes(REWRITE_DEL_MARK), '修改行删除片段应含首轮独有的措辞');
    assert.ok(modifiedRow[0].includes(REWRITE_INS_MARK), '修改行新增片段应含第二轮独有的措辞');
  });

  it('对比视图：无上一版的条目（首轮 / 无关条目）返回友好空态', async () => {
    const listHtml = await (await fetch(`${app.url}/`)).text();
    const round1Href = detailHrefOf(listHtml, TITLES.round1);
    const standaloneHref = detailHrefOf(listHtml, TITLES.standalone);

    for (const href of [round1Href, standaloneHref]) {
      const response = await fetch(`${app.url}${href}/diff`);
      assert.equal(response.status, 200, `条目 ${href} 的对比视图应 200`);
      const html = await response.text();
      assert.match(html, /data-testid="diff-empty"/, '应渲染空态而非报错');
      assert.match(html, /没有可对比的上一版本/, '空态文案应友好');
    }

    // 不存在的条目 404
    const missing = await fetch(`${app.url}/notices/0000000000000000/diff`);
    assert.equal(missing.status, 404);
  });

  it('重复抓取幂等：版本链关联不漂移', async () => {
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /源 npc 抓取完成：列表 3 条，新增 0，更新 3/);

    const listHtml = await (await fetch(`${app.url}/`)).text();
    const round1Href = detailHrefOf(listHtml, TITLES.round1);
    const round2Href = detailHrefOf(listHtml, TITLES.round2);

    const round2 = await (await fetch(`${app.url}${round2Href}`)).text();
    assert.match(round2, /data-testid="compare-previous-link"/, '重复抓取后对比入口仍在');

    const diff = stripSsrComments(await (await fetch(`${app.url}${round2Href}/diff`)).text());
    assert.match(diff, /这是第 2 轮征求意见稿/, '重复抓取后轮次不变');
    assert.match(
      diff,
      new RegExp(`data-testid="diff-previous-link"[^>]*href="${round1Href}"|href="${round1Href}"[^>]*data-testid="diff-previous-link"`),
      '重复抓取后仍指向同一上一版',
    );
    assert.match(diff, /data-testid="diff-added"/);
    assert.match(diff, /data-testid="diff-removed"/);
    assert.match(diff, /data-testid="diff-modified"/);
  });
});
