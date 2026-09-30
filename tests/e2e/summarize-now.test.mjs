import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

/**
 * 端到端（2026-09-30）：`scripts/summarize-now.mjs` —— **点名给已截止条目补摘要**。
 *
 * 为什么只能在"真把脚本当进程跑一遍"这一层验：入队条件（`ai_summary_json IS NULL AND
 * summary_status='pending' AND status <> 'closed'`）与 `--replace` 的拒绝、`--limit` 的
 * 上限、`#BACKUP` 备份行都是**进程边界**上的东西（参数解析、退出码、stdout），
 * 直接调仓库函数测不到。
 *
 * 三条主判据（本工具存在的理由是第一条）：
 * ① 默认只读：一个字都不写库、一次 LLM 调用都不发；
 * ② `--apply` 能给**已截止**的那条产出摘要 —— 而它的草案全文就在公告正文里
 *    （`bodyLooksLikeDraft`，这类源不发附件），所以产出的摘要里真的有条文要点；
 * ③ 已经有摘要的条目不给 `--replace` 时当场拒绝（一个字节都不改），
 *    给了才覆盖、且覆盖前把旧值打成 `#BACKUP` 行（`compose run --rm` 会删掉容器内写的文件，
 *    stdout 才是不会丢的那份备份）。
 *
 * 零外部依赖（ADR-0001）：临时 SQLite + stub LLM + stub 邮件，**不起 web、不出网**。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-summarize-now-'));
const dbFile = path.join(workDir, 'app.db');
const callsFile = path.join(workDir, 'llm-calls.jsonl');

/**
 * 已截止、**正文自带条文**的条目（生产上那两条的形状：`0b00deff17dfa050`
 * 《反网络暴力法（征求意见稿）》正文 10,896 字 / 78 处条号）。
 * 它永远排不进摘要队列 —— 这正是本工具存在的理由。
 */
const CLOSED_INLINE = '0b00deff17dfa050';
const CLOSED_INLINE_TITLE = '中华人民共和国反网络暴力法（征求意见稿）';
/** 进行中的普通条目（公告壳）。与上面那条**共用前缀 `0b`**，用来钉"前缀不唯一" */
const ONGOING = '0b01aa11bb22cc33';
const ONGOING_TITLE = '关于征求某行业标准意见的公告';
/** 已经有摘要的条目：默认拒绝覆盖，要 `--replace` */
const WITH_SUMMARY = '9f8e7d6c5b4a3928';
const WITH_SUMMARY_TITLE = '某条例（征求意见稿）';

/** `--limit` 上限的 6 条夹具（只有参数层的用例碰它们，永远是只读） */
const LIMIT_FIXTURES = Array.from({ length: 6 }, (_, index) => ({
  id: `${index + 1}a`.repeat(8),
  title: `第 ${index + 1} 条上限夹具`,
}));

/**
 * 公告正文里直接给出的草案全文：≥1,500 字符 + ≥5 处「第X条」（`bodyLooksLikeDraft`
 * 的两个门槛）。**两个门槛都不在测试里重算** —— 判据是共用实现算的，这里要断言的是
 * "工具说它喂进去了 1 份"，那正是门槛通过的证据。
 */
const INLINE_DRAFT_BODY = [
  '现将《中华人民共和国反网络暴力法（征求意见稿）》全文公布，征求社会各界意见。',
  ...Array.from({ length: 26 }, (_, index) => {
    const no = index + 1;
    return (
      `第${no}条 网络信息服务提供者应当建立健全网络暴力信息防护机制，` +
      `发现相关信息的，应当及时采取删除、屏蔽、断开链接等处置措施，` +
      `并向有关部门报告（第${no}项示例条文，仅用于测试）。`
    );
  }),
  '以上条文自公布之日起施行，请于截止日期前反馈意见。',
].join('\n');

/** 覆盖前必须被备份下来的旧值（断言 `#BACKUP` 行里带着它） */
const OLD_SUMMARY = JSON.stringify({
  what: { text: '【旧摘要】这是上一次生成的摘要，覆盖前必须留下备份。', quote: null },
  deadline: { text: null, quote: null },
  howToComment: { text: '登录官网提交', quote: null },
  keyPoints: [],
  changes: [],
});

let db;
let setSummary;

/** 单轮运行真实脚本子进程；extraEnv 只注入本次运行。返回 { code, output }。 */
function runScript(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/summarize-now.mjs', ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DB_DRIVER: 'sqlite',
        DATABASE_URL: dbFile,
        LLM_PROVIDER: 'stub',
        MAILER_PROVIDER: 'stub',
        ATTACHMENT_TEXT: 'on',
        // 重试退避基数调小：失败路径的总耗时可忽略（与 summary-pipeline 同一手法）
        SUMMARY_RETRY_DELAY_MS: '10',
        LLM_STUB_CALLS_FILE: callsFile,
        ...extraEnv,
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

/**
 * 该条目**至今**真实发生的 LLM 调用次数（stub 的 JSONL 调用日志跨进程累计）。
 * 单个用例要断言"这一次跑了几次"，所以一律用它取差值 —— 写绝对值的话，
 * 前一条用例的同标题调用会把后一条的断言顶歪（本轮实测：4 变成 5）。
 */
function callsFor(title) {
  if (!fs.existsSync(callsFile)) return 0;
  return fs
    .readFileSync(callsFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((line) => JSON.parse(line).title === title).length;
}

const rowOf = (id) => db.prepare('select * from notices where id = ?').get(id);
const ftsCount = () => db.prepare('select count(*) as n from notices_fts').get().n;

before(async () => {
  process.env.DB_DRIVER = 'sqlite';
  process.env.DATABASE_URL = dbFile;
  process.env.LLM_PROVIDER = 'stub';
  process.env.MAILER_PROVIDER = 'stub';
  process.env.ATTACHMENT_TEXT = 'on';

  const noticesRepo = await import('../../src/db/repo/notices.ts');
  const sourcesRepo = await import('../../src/db/repo/sources.ts');
  await sourcesRepo.registerSource({ id: 'e2e-summarize-now', name: '点名摘要源', adapterType: 'fixture' });

  const open = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
  const fixtures = [
    {
      id: CLOSED_INLINE,
      title: CLOSED_INLINE_TITLE,
      status: 'closed',
      deadlineAt: '2020-01-05',
      // 草案全文在正文里：一条附件都没有（cac 那类源就长这样）
      bodyText: INLINE_DRAFT_BODY,
      attachments: [],
    },
    {
      id: ONGOING,
      title: ONGOING_TITLE,
      status: 'open',
      deadlineAt: open,
      bodyText: '现向社会公开征求意见。',
      attachments: [],
    },
    {
      id: WITH_SUMMARY,
      title: WITH_SUMMARY_TITLE,
      status: 'open',
      deadlineAt: open,
      bodyText: '现向社会公开征求意见。',
      attachments: [],
    },
    ...LIMIT_FIXTURES.map((item) => ({
      id: item.id,
      title: item.title,
      status: 'open',
      deadlineAt: open,
      bodyText: '现向社会公开征求意见。',
      attachments: [],
    })),
  ];
  for (const fixture of fixtures) {
    await noticesRepo.upsertNotice({
      id: fixture.id,
      sourceId: 'e2e-summarize-now',
      title: fixture.title,
      agency: '测试机关',
      url: `https://source.test/${fixture.id}.html`,
      publishedAt: new Date().toISOString().slice(0, 10),
      deadlineAt: fixture.deadlineAt,
      status: fixture.status,
      bodyText: fixture.bodyText,
      attachments: fixture.attachments,
      fetchedAt: new Date().toISOString(),
    });
  }

  db = new Database(dbFile);
  setSummary = db.prepare(
    'update notices set ai_summary_json = ?, summary_model = ?, summary_status = ?, summary_diagnostics_json = null where id = ?',
  );
});

/**
 * 每个用例都从同一份初始状态开始：`--apply` 会写库，用例之间共享状态的话，
 * 第二条用例看到的是第一条改过的库（`redraft-ids.test.mjs` 就踩过这个坑）。
 */
beforeEach(() => {
  setSummary.run(null, null, 'pending', CLOSED_INLINE);
  setSummary.run(null, null, 'pending', ONGOING);
  setSummary.run(OLD_SUMMARY, 'mimo-v2.5', 'done', WITH_SUMMARY);
});

describe('2026-09-30：summarize-now 点名给已截止条目补摘要', () => {
  it('默认只读：逐条打印事实（含已截止那条会喂进去几份），一个字都不写、一次调用都不发', async () => {
    const beforeRows = [CLOSED_INLINE, ONGOING, WITH_SUMMARY].map((id) => JSON.stringify(rowOf(id)));
    const beforeFts = ftsCount();
    const closedCalls = callsFor(CLOSED_INLINE_TITLE);
    const ongoingCalls = callsFor(ONGOING_TITLE);

    const { code, output } = await runScript(['--ids', '0b00deff,0b01']);
    assert.equal(code, 0, output);

    // 事实照实打印：已截止**不是**拒绝的理由（这正是它的用途）
    assert.match(output, /已截止：是（队列永远不放行/);
    assert.match(output, /库内 status=closed/);
    assert.match(output, /受众面：/);
    assert.match(output, /已有摘要：无/);
    // 正文自带条文的判据（bodyLooksLikeDraft）真的通过了 ⇒ 会喂进去 1 份、有汉字数
    assert.match(output, /喂入：1 份 \/ \d+ 汉字/);
    assert.match(output, /公告正文/);
    // 进行中的那条没有任何可喂的条文 ⇒ 照实说 0 份
    assert.match(output, /喂入：0 份/);
    assert.match(output, /只读模式（未加 --apply）：一个字都没改/);

    assert.deepEqual(
      [CLOSED_INLINE, ONGOING, WITH_SUMMARY].map((id) => JSON.stringify(rowOf(id))),
      beforeRows,
      'dry-run 不许动 notices 的任何一列',
    );
    assert.equal(ftsCount(), beforeFts, 'dry-run 也不该碰检索索引');
    assert.equal(callsFor(CLOSED_INLINE_TITLE) - closedCalls, 0, 'dry-run 一次 LLM 调用都不该发生');
    assert.equal(callsFor(ONGOING_TITLE) - ongoingCalls, 0);
  });

  it('--apply：给**已截止**的那条产出摘要（正文那一份真的读过），名单外的条目一个字节不动', async () => {
    const ongoingBefore = JSON.stringify(rowOf(ONGOING));
    const withSummaryBefore = JSON.stringify(rowOf(WITH_SUMMARY));
    const closedCalls = callsFor(CLOSED_INLINE_TITLE);
    const ongoingCalls = callsFor(ONGOING_TITLE);

    const { code, output } = await runScript(['--ids', '0b00deff', '--apply']);
    assert.equal(code, 0, output);
    assert.match(output, /摘要完成/);
    assert.match(output, /完成：成功 1 条，转人工复核 0 条，中断 0 条/);

    const row = rowOf(CLOSED_INLINE);
    assert.equal(row.summary_status, 'done', '已截止条目也有摘要了 —— 这就是这个工具存在的理由');
    assert.equal(row.summary_model, 'stub');
    assert.ok(row.ai_summary_json, '摘要 JSON 应落库');
    // stub 只在**真的收到 draftSources** 时才产出条文要点 ⇒ 正文那一份确实进了提示词
    assert.match(row.ai_summary_json, /条文要点/, '正文自带条文的条目应当产出可核对的条文要点');
    assert.ok(row.summary_diagnostics_json, '诊断与摘要一起落库');
    assert.match(row.summary_diagnostics_json, /"origin":"body"/, '诊断里记着这一份来自公告正文');
    assert.equal(callsFor(CLOSED_INLINE_TITLE) - closedCalls, 1, '一条一次调用');
    // 索引同步也在共用链路里（失败只降级，但正常路径下它必须发生）
    assert.equal(
      db.prepare('select count(*) as n from notices_fts where notice_id = ?').get(CLOSED_INLINE).n,
      1,
      '摘要落库后该条目应被重刷进检索索引',
    );

    assert.equal(JSON.stringify(rowOf(ONGOING)), ongoingBefore, '没点名的条目不许被碰');
    assert.equal(JSON.stringify(rowOf(WITH_SUMMARY)), withSummaryBefore, '同上');
    assert.equal(callsFor(ONGOING_TITLE) - ongoingCalls, 0);
  });

  it('已有摘要的条目：不给 --replace 当场拒绝（一条都没动），给了才覆盖且先打 #BACKUP', async () => {
    const refusedCalls = callsFor(WITH_SUMMARY_TITLE);
    const refused = await runScript(['--ids', '9f8e7d6c', '--apply']);
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /已经有摘要（要覆盖请显式 --replace）/);
    assert.match(refused.output, /中止（一个字节都没改）/);
    assert.equal(rowOf(WITH_SUMMARY).ai_summary_json, OLD_SUMMARY, '拒绝时旧摘要必须原样留着');
    assert.equal(callsFor(WITH_SUMMARY_TITLE) - refusedCalls, 0, '拒绝路径一次调用都不该发');

    const replaced = await runScript(['--ids', '9f8e7d6c', '--apply', '--replace']);
    assert.equal(replaced.code, 0, replaced.output);
    // 备份的权威副本是 stdout（compose run --rm 里文件会随容器消失）——
    // 所以这里断言的是"旧摘要原样出现在 #BACKUP 行里"，不是"写文件成功了"
    const backupLine = replaced.output.split('\n').find((line) => line.startsWith('#BACKUP '));
    assert.ok(backupLine, `应有一行 #BACKUP：${replaced.output}`);
    assert.match(backupLine, /【旧摘要】/);
    assert.match(backupLine, new RegExp(WITH_SUMMARY));
    assert.equal(callsFor(WITH_SUMMARY_TITLE) - refusedCalls, 1);
    const row = rowOf(WITH_SUMMARY);
    assert.equal(row.summary_status, 'done');
    assert.ok(!row.ai_summary_json.includes('【旧摘要】'), '覆盖后旧值不该还在');
  });

  it('失败要交出来：stub 全部失败时转人工复核、退出码非 0，且**不发**任务告警（不占当日那封）', async () => {
    const outboxFile = path.join(workDir, 'outbox.jsonl');
    const closedCalls = callsFor(CLOSED_INLINE_TITLE);
    const { code, output } = await runScript(['--ids', '0b00deff', '--apply'], {
      LLM_STUB_FAILURES: 'always',
      // 告警通道是通的（这是与"没配 ALERT_EMAIL 所以本来就不会发"区分开的关键）
      ALERT_EMAIL: 'ops@test.local',
      MAILER_OUTBOX_FILE: outboxFile,
    });
    assert.equal(code, 1, output);
    assert.match(output, /摘要失败：已重试 3 次仍失败，转人工复核/);
    assert.match(output, /完成：成功 0 条，转人工复核 1 条，中断 0 条/);
    // 首调 + 3 次重试：次数由共用实现决定，工具不另写一份
    assert.equal(callsFor(CLOSED_INLINE_TITLE) - closedCalls, 4);
    assert.equal(rowOf(CLOSED_INLINE).summary_status, 'failed_review');
    assert.equal(rowOf(CLOSED_INLINE).ai_summary_json, null);
    assert.ok(
      !fs.existsSync(outboxFile),
      '工具不该顶着 summarize-notices 这个任务名发告警（会把当天该源真正的那封挤掉）',
    );
  });

  it('--limit：缺省不让一次点超过 5 条；点名不唯一 / 不存在也当场报错退出', async () => {
    const ids = LIMIT_FIXTURES.map((item) => item.id.slice(0, 2)).join(',');
    const tooMany = await runScript(['--ids', ids]);
    assert.equal(tooMany.code, 1, tooMany.output);
    assert.match(tooMany.output, /超过本次上限 5/);
    assert.match(tooMany.output, /--limit 6/);

    const allowed = await runScript(['--ids', ids, '--limit', '6']);
    assert.equal(allowed.code, 0, allowed.output);
    assert.match(allowed.output, /点名 6 条/);
    assert.match(allowed.output, /只读模式（未加 --apply）/);

    const ambiguous = await runScript(['--ids', '0b', '--apply']);
    assert.equal(ambiguous.code, 1, ambiguous.output);
    assert.match(ambiguous.output, /前缀不唯一/);

    const unknown = await runScript(['--ids', 'deadbeef', '--apply']);
    assert.equal(unknown.code, 1, unknown.output);
    assert.match(unknown.output, /库里没有以它开头的条目/);
    assert.match(unknown.output, /一个字节都没改/);
  });
});
