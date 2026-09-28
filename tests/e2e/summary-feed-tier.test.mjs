import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';

import { parseSummaryDiagnostics } from '../../src/lib/summary-diagnostics.ts';
import { SUMMARY_TIERS } from '../../src/lib/attachment-feed.ts';

/**
 * 端到端（issue #86 第 3 刀）：**喂入档位真的接到了受众面上**。
 *
 * 为什么必须端到端跑一次：这一刀加的东西分布在四层里 —— 仓库查询要 select 出 `audience`、
 * worker 要按它选档、预算要真的改变送进提示词的那一截、诊断要把它记下来。任何一层漏了，
 * 表现都是**静默的**：档位没接上就是"还是老样子"（没有报错、没有异常数据），
 * 而"到底喂了多少"此前从来不落库，事后根本查不出来。
 *
 * 夹具刻意让两条条目**用同一批附件正文**（三份：一份 30,000 字符的编制说明 +
 * 两份两万/两千字符的条文），差别只有标题 ⇒ 受众面。于是两条诊断里窗口大小的差别
 * 只可能来自档位，不可能来自"附件不一样"。
 *
 * 零外部依赖（ADR-0001）：临时 SQLite + stub LLM，不起 web、不出网。
 */

const PUBLIC_ID = 'a1'.repeat(16);
const SECTOR_ID = 'b2'.repeat(16);
const SOURCE_ID = 'e2e-feed-tier';

/** 每一行都带序号：这样"尾行在不在"才是判据（重复文本里 `includes` 会假绿）。 */
function chineseLines(count, prefix) {
  return Array.from(
    { length: count },
    (_, i) =>
      `第${i + 1}项 ${prefix}第${i + 1}类情形的，应当依照本条规定办理；不符合的，不得办理。\n`,
  ).join('');
}

const EXPLANATION_NAME = '某某条例（草案征求意见稿）编制说明.docx';
const DRAFT_LONG_NAME = '某某条例（草案征求意见稿）.docx';
const DRAFT_SHORT_NAME = '某某条例（草案征求意见稿）附件二.docx';
const FILES = [
  { name: EXPLANATION_NAME, url: 'https://attachments.test/feed-explain.docx', text: chineseLines(1_000, '编制说明就') },
  { name: DRAFT_LONG_NAME, url: 'https://attachments.test/feed-draft.docx', text: chineseLines(700, '本条例规定') },
  { name: DRAFT_SHORT_NAME, url: 'https://attachments.test/feed-draft2.docx', text: chineseLines(80, '本条例附则规定') },
];

let workDir;
let dbFile;
let callsFile;
let summarizeJob;

const ctx = { logger: () => {}, now: () => new Date() };

/** stub 每次调用追加一行 JSONL（含档位）——跨进程断言"档位真的传到了端口"就靠它。 */
function readCalls() {
  if (!fs.existsSync(callsFile)) return [];
  return fs
    .readFileSync(callsFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function readDiagnostics(id) {
  const db = new Database(dbFile, { readonly: true });
  try {
    const row = db
      .prepare('select audience, summary_status as status, summary_diagnostics_json as d from notices where id = ?')
      .get(id);
    return {
      audience: row?.audience ?? null,
      status: row?.status ?? null,
      diagnostics: row?.d ? parseSummaryDiagnostics(JSON.parse(row.d)) : null,
    };
  } finally {
    db.close();
  }
}

before(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-feed-tier-'));
  dbFile = path.join(workDir, 'app.db');
  callsFile = path.join(workDir, 'llm-calls.jsonl');
  process.env.DB_DRIVER = 'sqlite';
  process.env.DATABASE_URL = dbFile;
  process.env.LLM_PROVIDER = 'stub';
  process.env.MAILER_PROVIDER = 'stub';
  process.env.ATTACHMENT_TEXT = 'on';
  process.env.LLM_STUB_CALLS_FILE = callsFile;

  const noticesRepo = await import('../../src/db/repo/notices.ts');
  const attachmentsRepo = await import('../../src/db/repo/attachments.ts');
  const sourcesRepo = await import('../../src/db/repo/sources.ts');
  summarizeJob = (await import('../../worker/jobs/summarize-notices.ts')).summarizeNoticesJob;

  await sourcesRepo.registerSource({ id: SOURCE_ID, name: '喂入档位测试源', adapterType: 'fixture' });

  const notices = [
    {
      id: PUBLIC_ID,
      title: '关于《中华人民共和国某某条例（草案征求意见稿）》公开征求意见的公告',
    },
    {
      id: SECTOR_ID,
      title: '关于征求《某某污水处理技术标准（征求意见稿）》意见的通知',
    },
  ];
  for (const notice of notices) {
    await noticesRepo.upsertNotice({
      id: notice.id,
      sourceId: SOURCE_ID,
      title: notice.title,
      agency: '测试部',
      url: `https://source.test/${notice.id}.html`,
      publishedAt: '2026-09-20',
      deadlineAt: '2026-11-30',
      status: 'open',
      bodyText: '现就上述文件公开征求意见，请于截止日期前反馈。',
      attachments: FILES.map((file) => ({ name: file.name, url: file.url })),
      fetchedAt: new Date().toISOString(),
    });
    // 清单必须**按公示一次给全**（否则后写的那份会把先写的撤下）
    await attachmentsRepo.syncAttachmentManifest({
      noticeId: notice.id,
      attachments: FILES.map((file) => ({ name: file.name, url: file.url })),
      now: new Date(),
    });
    for (const file of FILES) {
      await attachmentsRepo.markAttachmentResult(notice.id, file.url, {
        status: 'ok',
        kind: 'docx',
        bytes: 4096,
        contentHash: `e2e-${notice.id}-${file.url}`,
        charCount: file.text.length,
        extractedText: file.text,
        fetchedAt: new Date(),
      });
    }
  }

  await summarizeJob.run(ctx);
});

after(() => {
  delete process.env.ATTACHMENT_TEXT;
  delete process.env.LLM_STUB_CALLS_FILE;
  // 刻意不删临时目录：进程内 SQLite 连接仍持句柄，Windows 上 rmSync 会 EPERM（与各 e2e 一致）
});

describe('issue #86 第 3 刀：受众面决定喂入档位', () => {
  it('前提：两条条目的受众面确实按标题判成了一公一专', () => {
    assert.equal(readDiagnostics(PUBLIC_ID).audience, 'public', '法律/条例草案应判公众广域');
    assert.equal(readDiagnostics(SECTOR_ID).audience, 'sector', '技术标准应判行业专业');
  });

  it('公众广域走重档、行业专业走标准档，且都真的落库了喂入清单', () => {
    const pub = readDiagnostics(PUBLIC_ID);
    const sec = readDiagnostics(SECTOR_ID);
    assert.equal(pub.status, 'done', '摘要要真的生成过，否则这条用例只是"没跑"');
    assert.equal(sec.status, 'done');
    assert.ok(pub.diagnostics?.feed, '公众广域那条必须带着喂入清单');
    assert.ok(sec.diagnostics?.feed, '行业专业那条也必须带着喂入清单');
    assert.equal(pub.diagnostics.feed.tier, 'deep');
    assert.equal(sec.diagnostics.feed.tier, 'standard');
  });

  it('同一批附件、只有受众面不同 ⇒ 重档读到的大头文件是标准档的两倍', () => {
    const pub = readDiagnostics(PUBLIC_ID).diagnostics.feed;
    const sec = readDiagnostics(SECTOR_ID).diagnostics.feed;
    assert.equal(pub.sources.length, 3, '三份附件都该进喂入清单');
    assert.equal(sec.sources.length, 3);
    // 第一份就是那份 30,000 字符的编制说明（仓库层按字数降序取）
    const pubFirst = pub.sources[0];
    const secFirst = sec.sources[0];
    assert.match(pubFirst.name, /编制说明/);
    assert.equal(pubFirst.role, 'explanation', '角色按文件名判，说明要落在说明那一侧');
    assert.equal(secFirst.role, 'explanation');
    assert.ok(
      secFirst.chars <= SUMMARY_TIERS.standard.perSource,
      `标准档不该超过单份上限，实际 ${secFirst.chars}`,
    );
    assert.ok(
      pubFirst.chars > SUMMARY_TIERS.standard.perSource,
      `重档必须超过标准档的单份上限，实际 ${pubFirst.chars}`,
    );
    assert.ok(pubFirst.truncated, '30,000 字符的说明在两种档位下都是被截过的');
    assert.ok(
      pubFirst.fedCjk > secFirst.fedCjk,
      `重档读到的汉字数必须更多（这一刀的全部意义）：重档 ${pubFirst.chars} 字符/${pubFirst.fedCjk} 汉字，标准档 ${secFirst.chars} 字符/${secFirst.fedCjk} 汉字`,
    );
  });

  it('两档都不许把任何一份饿死，且花掉的汉字数不超预算', () => {
    for (const id of [PUBLIC_ID, SECTOR_ID]) {
      const feed = readDiagnostics(id).diagnostics.feed;
      assert.deepEqual(feed.starved, [], '三份都在预算内 ⇒ 一份都不该被挤掉');
      assert.ok(
        feed.usedCjk <= feed.budget.total,
        `实际花掉 ${feed.usedCjk} 汉字，超出预算 ${feed.budget.total}`,
      );
      assert.equal(feed.budget.perSource, SUMMARY_TIERS[feed.tier].perSource);
    }
  });

  it('喂入清单里的字数与原件对得上（不是估的：短附件要整份进去）', () => {
    const feed = readDiagnostics(PUBLIC_ID).diagnostics.feed;
    const short = feed.sources.find((item) => item.name === DRAFT_SHORT_NAME);
    assert.ok(short, '第三份附件要在清单里');
    assert.equal(short.chars, FILES[2].text.trim().length, '短附件应当整份进得去');
    assert.equal(short.truncated, false);
    assert.equal(short.fedCjk, short.fullCjk, '整份进去时"送进去的汉字数"就是它自己的汉字数');
  });

  it('档位真的传到了端口（不是只在 worker 里算了一下）', () => {
    const calls = readCalls();
    assert.equal(calls.length, 2, `两条条目各调一次，实际 ${calls.length} 次`);
    const byTier = new Map(calls.map((call) => [call.url, call.tier]));
    assert.equal(byTier.get(`https://source.test/${PUBLIC_ID}.html`), 'deep');
    assert.equal(byTier.get(`https://source.test/${SECTOR_ID}.html`), 'standard');
  });
});
