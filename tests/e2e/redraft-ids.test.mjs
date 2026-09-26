import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

/**
 * 端到端（issue #79）：`reset-summaries-for-redraft.mjs --ids` —— **点名重跑**。
 *
 * 为什么需要它：体裁模板变了（例如 #79 把 5 条从「修正案」改成「新案草案」）时，
 * 要重跑的是"摘要的写法"，而这些条目**往往已经带着可核对的条文要点** ——
 * 恰好会被脚本那层幂等过滤（"已经有条文要点就跳过"）全部挡掉。
 * 所以 `--ids` 必须明确绕过那层过滤，同时**绝不能**绕过唯一那条硬红线：
 * 已截止的条目清了就永久失去摘要。
 *
 * 这些判据只有在"真把脚本当进程跑一遍"时才成立：参数解析、退出码、stdout 上的
 * `#BACKUP` 备份行，都是脚本层的东西，直接调仓库函数测不到（`summary-redraft.test.mjs`
 * 测的是函数那一层）。
 *
 * 零外部依赖（ADR-0001）：临时 SQLite + stub 端口，脚本 import 的就是仓库源码。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-redraft-ids-'));
const dbFile = path.join(workDir, 'app.db');
const backupDir = path.join(workDir, 'backups');

/** 带了可核对条文要点的条目（幂等过滤会跳过它，正是 --ids 存在的理由） */
const WITH_POINTS = 'a1'.repeat(16);
/** 普通条目（有摘要、没有条文要点）。与下面那条**共用前缀 b**，用来钉"前缀不唯一" */
const PLAIN = 'b2'.repeat(16);
/** 已截止（硬红线：不许清）。同样以 b 开头，所以 `--ids b` 必须报歧义 */
const CLOSED = 'b3'.repeat(16);

let db;

function summaryJson(marker, withPoints) {
  return JSON.stringify({
    what: { text: `${marker}：旧摘要`, quote: null },
    deadline: { text: null, quote: null },
    howToComment: { text: '登录官网提交', quote: null },
    keyPoints: withPoints
      ? [{ text: '条文要点', quote: null, source: '某附件.docx', sourceUrl: 'https://a.test/x.docx' }]
      : [],
    changes: [],
  });
}

function runScript(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/reset-summaries-for-redraft.mjs', ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DB_DRIVER: 'sqlite',
        DATABASE_URL: dbFile,
        LLM_PROVIDER: 'stub',
        MAILER_PROVIDER: 'stub',
        ATTACHMENT_TEXT: 'off',
        REDRAFT_BACKUP_DIR: backupDir,
      },
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

const summaryOf = (id) =>
  db.prepare('select ai_summary_json as json, summary_status as status from notices where id = ?').get(id);

before(async () => {
  process.env.DB_DRIVER = 'sqlite';
  process.env.DATABASE_URL = dbFile;
  process.env.LLM_PROVIDER = 'stub';
  process.env.MAILER_PROVIDER = 'stub';
  process.env.ATTACHMENT_TEXT = 'off';

  const noticesRepo = await import('../../src/db/repo/notices.ts');
  const sourcesRepo = await import('../../src/db/repo/sources.ts');
  await sourcesRepo.registerSource({ id: 'e2e-redraft-ids', name: '点名重跑源', adapterType: 'fixture' });

  const open = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
  for (const [id, title, status] of [
    [WITH_POINTS, '甲：已带条文要点', 'open'],
    [PLAIN, '乙：普通条目', 'open'],
    [CLOSED, '丙：已截止', 'closed'],
  ]) {
    await noticesRepo.upsertNotice({
      id,
      sourceId: 'e2e-redraft-ids',
      title,
      agency: '测试机关',
      url: `https://source.test/${id}.html`,
      publishedAt: new Date().toISOString().slice(0, 10),
      deadlineAt: status === 'closed' ? '2020-01-05' : open,
      status,
      bodyText: '现向社会公开征求意见。',
      attachments: [],
      fetchedAt: new Date().toISOString(),
    });
  }

  db = new Database(dbFile);
  setSummaryFor = db.prepare(
    'update notices set ai_summary_json = ?, summary_model = ?, summary_status = ? where id = ?',
  );
});

let setSummaryFor;

/**
 * 每个用例都从同一份初始状态开始：这个脚本**会写库**，用例之间共享状态的话，
 * 第二条用例看到的是第一条改过的库（我第一版就是这么写错的 —— "前缀不唯一"与
 * "池子里还剩谁"两条都被前一条清了库而变成假红/假绿）。
 */
beforeEach(() => {
  setSummaryFor.run(summaryJson('甲', true), 'mimo-v2.5', 'done', WITH_POINTS);
  setSummaryFor.run(summaryJson('乙', false), 'mimo-v2.5', 'done', PLAIN);
  setSummaryFor.run(summaryJson('丙', false), 'mimo-v2.5', 'done', CLOSED);
});

describe('issue #79：--ids 点名重跑', () => {
  it('不带 --apply 时只报告，一个字都不改（且认得出"已经有条文要点"那条）', async () => {
    const { code, output } = await runScript(['--ids', WITH_POINTS.slice(0, 8)]);
    assert.equal(code, 0, output);
    assert.match(output, /点名重跑 1 条/);
    assert.match(output, /只读模式（未加 --apply）/);
    assert.match(summaryOf(WITH_POINTS).json, /甲：旧摘要/, 'dry-run 不许动库');
  });

  it('--apply 时绕过幂等过滤：带条文要点的那条也会被清空，且备份行打到 stdout', async () => {
    const { code, output } = await runScript(['--apply', '--ids', WITH_POINTS.slice(0, 8)]);
    assert.equal(code, 0, output);
    // 备份的权威副本是 stdout（compose run --rm 里文件会随容器消失）——
    // 所以这条断言的是"旧摘要原样出现在 #BACKUP 行里"，不是"文件写成功了"
    const backupLine = output.split('\n').find((line) => line.startsWith('#BACKUP '));
    assert.ok(backupLine, `应有一行 #BACKUP：${output}`);
    assert.match(backupLine, /甲：旧摘要/);
    assert.match(output, /已清空并置回 pending：1 条/);
    const after = summaryOf(WITH_POINTS);
    assert.equal(after.json, null);
    assert.equal(after.status, 'pending');
    assert.ok(fs.existsSync(backupDir), '备份目录应当被创建（外挂时它才是持久的）');
  });

  it('前缀不认识：当场报错退出，不清任何东西', async () => {
    const { code, output } = await runScript(['--apply', '--ids', 'deadbeef']);
    assert.equal(code, 1);
    assert.match(output, /没有以它开头/);
    assert.match(output, /一个字节都没改/);
  });

  it('前缀不唯一：报错而不是猜一个', async () => {
    const { code, output } = await runScript(['--ids', 'b']);
    assert.equal(code, 1, `前缀 b 同时匹配两条：应当拒绝。输出：${output}`);
    assert.match(output, /前缀不唯一/);
    assert.match(summaryOf(PLAIN).json, /乙：旧摘要/, '报歧义时一个字都不许改');
  });

  it('已截止的条目：--ids 也绕不过这条硬红线（清了就永久失去摘要）', async () => {
    const { code, output } = await runScript(['--apply', '--ids', CLOSED.slice(0, 8)]);
    assert.equal(code, 1);
    assert.match(output, /已截止/);
    assert.match(summaryOf(CLOSED).json, /丙：旧摘要/, '已截止条目的摘要必须原样留着');
  });

  it('不带 --ids 时行为不变：仍走池子 + 幂等过滤（甲被跳过、丙被排除、乙没有可读条文 ⇒ 不动）', async () => {
    const { code, output } = await runScript(['--apply', '--limit', '1']);
    assert.equal(code, 0, output);
    assert.match(output, /可置换池 1 条/, '甲已带条文要点、丙已截止 ⇒ 池子里只剩乙');
    // 乙没有任何附件 ⇒ `draftSourcesForSummary` 返回空 ⇒ 不在候选里（重跑只会白花一次调用）
    assert.match(output, /没有可置换的条目/);
    assert.match(summaryOf(PLAIN).json, /乙：旧摘要/, '一个字都不该动');
    assert.match(summaryOf(CLOSED).json, /丙：旧摘要/);
  });
});
