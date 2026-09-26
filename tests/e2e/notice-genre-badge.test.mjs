import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { startAppServer } from './helpers/app-server.mjs';
import { createFixtureServer } from './helpers/fixture-server.mjs';
import { noticeItems, stripSsrComments as stripComments } from './helpers/html.mjs';

/**
 * E2E（issue #76）：体裁要**读者看得见**，而且必须是真跑一轮抓取之后的结果。
 *
 * 为什么值得为一个小角标开一条 e2e：判定的输入来自三个地方（标题、附件名、附件正文），
 * 其中两个要等 worker 的抽取任务。单测只能证明纯函数对，证明不了
 * 「抓取入库 → 判定落库 → 详情页读到它」这条链是通的 —— 而 #68/#70 的教训正是
 * 链条中间断一环，两端各自都"看起来正常"。
 *
 * 断言刻意只依赖真实 fixture 的标题形状：
 * - 交通运输部那条是「公路法（**修正草案**征求意见稿）」⇒ 修正案；
 * - 工业和信息化部那条是「无线电频率划分**规定**（征求意见稿）」⇒ 新案草案。
 * 这两类正好是读者最需要在开读前知道自己拿的是哪一种的两种。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures', 'e2e-sources');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-genre-'));
const dbFile = path.join(workDir, 'app.db');

const AMENDMENT_TITLE = '关于《中华人民共和国公路法（修正草案征求意见稿）》公开征求意见的通知';
const NEW_DRAFT_TITLE = '公开征求对《中华人民共和国无线电频率划分规定（征求意见稿）》的意见';

let app;
let fixtures;

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

async function detailOf(title) {
  const list = await (await fetch(`${app.url}/`)).text();
  for (const block of noticeItems(list)) {
    const anchor = /<a[^>]*notice-title-link[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/.exec(block);
    if (anchor && anchor[2].trim() === title) {
      const response = await fetch(`${app.url}${anchor[1]}`);
      assert.equal(response.status, 200);
      return stripComments(await response.text());
    }
  }
  throw new Error(`列表页应含条目「${title}」`);
}

function badgeOf(html) {
  const match = /<span class="genre-badge"[^>]*>([^<]*)<\/span>/.exec(html);
  return match ? match[1].trim() : null;
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
      ATTACHMENT_TEXT: 'off',
    },
  });

  // 真跑一轮抓取：判定必须在**入库路径**上算出来，脚本里补的不算（issue #76）
  const run = await runWorkerOnce();
  assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
  // 刻意不强删 workDir：Windows 上 SQLite 文件句柄释放有延迟，rmSync 会 EPERM ——
  // 既有 e2e 也都是只停服务（临时目录交给系统）。
});
describe('issue #76：详情页体裁角标', () => {
  it('修正案标题的条目，读者在正文前就看到「修正案」', async () => {
    assert.equal(badgeOf(await detailOf(AMENDMENT_TITLE)), '修正案');
  });

  it('新起草的规定标成「新案草案」，不被误标成修正案', async () => {
    assert.equal(badgeOf(await detailOf(NEW_DRAFT_TITLE)), '新案草案');
  });

  it('角标只有两类真判出来的才出现，未判定不占位置', async () => {
    const amendment = await detailOf(AMENDMENT_TITLE);
    assert.equal(/class="genre-badge"/.test(amendment), true);
    // 状态徽标与体裁徽标各是各的：状态回答"来不来得及"，体裁回答"该看什么"
    assert.match(amendment, /data-testid="notice-status-badge"/);
  });

  /**
   * issue #79：这条正是线上那个空栏的形状 —— 体裁靠**正文里那截"现行"**判成修正案
   * （或者像这里一样靠标题），而改动点数出来是 0，页面于是渲染出：
   * 「改动点」标题 + 一句"没检测到成文的修改表述" + 一张没有行的表。
   *
   * 断言分两截，缺一截这条用例就会变成假绿灯：
   * 1. 先证明前提成立（库里真的有摘要、真的带着一份"数到 0 处"的覆盖度）——
   *    否则"页面上没有改动点"可能只是因为这条压根没摘要；
   * 2. 再断言整块不渲染，**连标题都不出现**（只剩 note 也算占着一栏）。
   */
  it('一处改动都数不到时，不渲染一个空的「改动点」栏', async () => {
    const db = new Database(dbFile, { readonly: true });
    const row = db
      .prepare('select genre, ai_summary_json as json from notices where title = ?')
      .get(AMENDMENT_TITLE);
    db.close();
    assert.equal(row?.genre, 'amendment', '上面那条用例已证它被判成修正案');
    assert.ok(row?.json, '这条应当有摘要（stub 端口），否则下面的断言测不到渲染分支');
    const summary = JSON.parse(row.json);
    assert.deepEqual(summary.changes, [], '没有可喂的附件正文 ⇒ 改动点必然是空数组');
    assert.equal(summary.changeMarkers?.total, 0, '分母是 0（不是"没数过"）—— 空栏就是这么长出来的');

    const html = await detailOf(AMENDMENT_TITLE);
    assert.match(html, /data-testid="ai-summary"/, '摘要卡片本身要在，排除"整页没渲染"这种假通过');
    assert.ok(
      !html.includes('data-testid="summary-changes"'),
      '一行改动点都没有时，整块「改动点」不该出现（空栏读起来像"这条没改什么"）',
    );
    assert.ok(!html.includes('改动点'), '连标题都不该有 —— 有标题就等于向读者承诺了一栏内容');
  });
});
