import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { createFixtureServer } from './helpers/fixture-server.mjs';
import { noticeIdForUrl } from '../../src/lib/notice-id.ts';

/**
 * E2E：人大网法律草案的**电子文档全文**（issue #86 第十八节）。
 *
 * 场景（全程零外部依赖，ADR-0001：SQLite 临时库 + 本地 fixture 源站 + stub LLM）：
 * 三轮真实的 worker 单轮运行，跑的是**同一条链路**（抓取 → 声明附件 → 下载 → 抽文本），
 * 只有开关与 fixture 在变：
 *
 * 1. 开关缺省（off）：`/fjxx/` **一个请求都不发**、一条附件都不声明 —— 这是"部署代码"
 *    与"开始拉几十 MB 的文件"两次决定分开的量具；
 * 2. 开关 on：适配器从官方的 `/fjxx/` 响应里拿到真文件名，声明 `attachment.pdf`，
 *    抽取任务把它下载、解析、存成条文（`notice_attachments.status='ok'`）；
 * 3. 开关 on 但 `/fjxx/` 404：**已入库的附件清单与已抽出的正文必须活下来** ——
 *    清单为空会让 `syncAttachmentManifest` 删掉那一行（连带条文正文），
 *    于是"源站今天抖了一下"退化成"这份草案我们从来没读过"，下一轮还要重下几十 MB。
 *
 * 用的是仓库里那份**逐字节照抄**的真实 `/fjxx/` 响应（fixtures/npc/flca/<lid>/fjxx/index.json，
 * 618 字节）与真实 lid；PDF 用仓库已有的中文文本层夹具 cjk-text.pdf 顶替那份 41 MB 的
 * 真文件 —— 41 MB 不进仓库，而"下载→解析→存文本"这条路径与文件大小无关。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-npc-draft-'));
const dbFile = path.join(workDir, 'app.db');
const fixturesDir = path.join(workDir, 'fixtures');

/** 道路交通安全法（修订草案）：仓库 fixture 里恰好有这个 lid 的详情快照 */
const LID = 'ff8081819ff54ab801a03d624f823cc3';
const OFFICIAL_FILE_NAME = '道路交通安全法（修订草案）.PDF';
const DRAFT_PDF = path.join(repoRoot, 'fixtures', 'e2e-attachments', 'cjk-text.pdf');

let fixtures;
let fixtureUrl;

/** 该条目的附件 PDF 在 fixture 源站上的路径（适配器声明的就是它，相对条目页推导） */
function draftPdfPath() {
  return path.join(fixturesDir, 'npc', 'flca', LID, 'attachment.pdf');
}

/** 该条目的 `/fjxx/` 快照（第三轮删掉它，模拟接口 404） */
function fjxxPath() {
  return path.join(fixturesDir, 'npc', 'flca', LID, 'fjxx', 'index.json');
}

function runWorkerOnce(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['worker/index.ts'], {
      cwd: repoRoot,
      env: { ...process.env, WORKER_ONCE: '1', ...extraEnv },
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

/** 库里这一条读了什么（直接读 SQLite，不经仓储层 —— 断言看的是落库的事实） */
function storedRow() {
  const db = new Database(dbFile, { readonly: true });
  try {
    const noticeId = noticeIdForUrl(`${fixtureUrl}/npc/userIndex.html?lid=${LID}`);
    const notice = db
      .prepare('select id, status, attachments_json from notices where id = ?')
      .get(noticeId);
    const rows = db
      .prepare(
        'select url, name, status, char_count, length(coalesce(extracted_text, \'\')) as text_len, error' +
          ' from notice_attachments where notice_id = ?',
      )
      .all(noticeId);
    return { noticeId, notice, rows };
  } finally {
    db.close();
  }
}

before(async () => {
  fs.cpSync(path.join(repoRoot, 'fixtures', 'npc'), path.join(fixturesDir, 'npc'), {
    recursive: true,
  });
  fs.mkdirSync(path.dirname(draftPdfPath()), { recursive: true });
  fs.copyFileSync(DRAFT_PDF, draftPdfPath());

  fixtures = createFixtureServer({ fixturesDir });
  fixtureUrl = (await fixtures.start()).url;

  process.env.DB_DRIVER = 'sqlite';
  process.env.DATABASE_URL = dbFile;
  process.env.FIXTURES_DIR = fixturesDir;
  process.env.SOURCES_FIXTURE_BASE = fixtureUrl;
  process.env.LLM_PROVIDER = 'stub';
  process.env.MAILER_PROVIDER = 'stub';
  process.env.MAILER_OUTBOX_FILE = path.join(workDir, 'outbox.jsonl');
  // 礼貌间隔在测试里不该真的等（产品行为由生产的那次实测钉）
  process.env.ATTACHMENT_HOST_INTERVAL_MS = '0';
  // 把**全站**上限收到 4 KB：那份 PDF 夹具是 133 KB，于是"它照旧被判 ok"这件事本身
  // 就是按源预算在生效的证据。真文件是 41 MB、真上限是 64 MB，这里只是为了在 4 KB
  // 这个量级上把判据逼出来。
  //
  // ⚠️ 这一条只能证明**下载那一处**用了按源预算，证不到"声明大小超限"那句判断：
  // fixture 源站是 chunked 响应、没有 content-length，`declaredTotalBytes` 因此返回
  // null，那句 `total > budget.maxBytes` 在这个夹具下**根本不执行**（2026-09-28 实测：
  // 第一版 pin 就钉在那里，撤掉实现照样绿 —— 假绿灯）。要钉那一句得让夹具回
  // content-length（另一个 e2e `attachment-extract-job.test.mjs` 里有那样的自建服务器）。
  process.env.ATTACHMENT_MAX_BYTES = '4096';
  // 黑名单缺省已是空；显式写空，防的是"某天有人把 npc 又加回去"这类回归
  process.env.ATTACHMENT_EXCLUDE_SOURCES = '';
});

after(() => {
  fixtures?.stop();
});

describe('npc 草案电子文档：开关关着时不发请求、不声明', () => {
  let run;
  before(async () => {
    delete process.env.NPC_DRAFT_ATTACHMENTS;
    run = await runWorkerOnce({ NPC_DRAFT_ATTACHMENTS: '' });
  });

  it('worker 单轮跑通，条目已入库', () => {
    assert.equal(run.code, 0, `worker 应正常退出：\n${run.output}`);
    const { notice } = storedRow();
    assert.ok(notice, '道路交通安全法那条应已入库');
    assert.equal(notice.status, 'open', '夹具的截止日期是 {{DATE+45}}，应判为进行中');
  });

  it('一条附件都不声明（关着的时候连 /fjxx/ 都不该请求）', () => {
    const { notice, rows } = storedRow();
    assert.deepEqual(JSON.parse(notice.attachments_json), [], '关着时附件清单必须是空的');
    assert.equal(rows.length, 0, '关着时不该有 notice_attachments 行');
  });
});

describe('npc 草案电子文档：开关打开后走完抓取→下载→抽取', () => {
  let run;
  before(async () => {
    run = await runWorkerOnce({ NPC_DRAFT_ATTACHMENTS: 'on' });
  });

  it('worker 单轮跑通', () => {
    assert.equal(run.code, 0, `worker 应正常退出：\n${run.output}`);
  });

  it('按官方文件名声明附件（名字来自 /fjxx/，不是标题拼的）', () => {
    const { notice } = storedRow();
    const declared = JSON.parse(notice.attachments_json);
    assert.equal(declared.length, 1, `应声明恰好一个附件：${notice.attachments_json}`);
    assert.equal(declared[0].name, OFFICIAL_FILE_NAME);
    assert.equal(declared[0].url, `${fixtureUrl}/npc/flca/${LID}/attachment.pdf`);
  });

  it('抽取任务把那份 PDF 下下来、抽成条文（status=ok 且有文本）', () => {
    const { rows } = storedRow();
    assert.equal(rows.length, 1, '应有一行附件状态');
    // 全站上限在这一轮被收到 4096 字节，而夹具是 133 KB：它照样 ok，说明整档下载用的是
    // **按源**那份预算（npc 声明 64 MB）。改回全局值，正文会被截成 4 KB，解析就落不了 ok。
    assert.equal(rows[0].status, 'ok', `实际是 ${rows[0].status}（${rows[0].error ?? '无'}）`);
    assert.ok(rows[0].char_count > 400, `汉字数应过条文阈值，实际 ${rows[0].char_count}`);
    assert.ok(rows[0].text_len > 400, '抽出的正文应已落库（摘要是从这里读的）');
  });
});

describe('npc 草案电子文档：/fjxx/ 404 时不许把已抽到的正文弄丢', () => {
  let run;
  before(async () => {
    // 删掉快照 = fixture 源站对这个路径回 404（等价于真实站点的接口抽风）
    fs.rmSync(fjxxPath());
    run = await runWorkerOnce({ NPC_DRAFT_ATTACHMENTS: 'on' });
  });

  it('清单取不到时留痕在日志里（不静默）', () => {
    assert.equal(run.code, 0, `worker 应正常退出：\n${run.output}`);
    assert.match(run.output, /附件清单获取失败/, '这一跳失败必须留下日志');
  });

  it('已入库的清单与已抽出的条文都还在（沿用上一轮，而不是清空）', () => {
    const { notice, rows } = storedRow();
    assert.equal(
      JSON.parse(notice.attachments_json).length,
      1,
      '清单为空会把 notice_attachments 的行删掉（连带条文正文）—— 必须沿用上一轮的清单',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'ok');
    assert.ok(rows[0].text_len > 400, '条文正文不该因为接口 404 而消失');
  });
});
