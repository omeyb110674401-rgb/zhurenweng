import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';

/**
 * 端到端（issue #57 第 5 / 6 步）：**同一份条文，`shadow` 与 `on` 产出的摘要必须不同**。
 *
 * 这条断言存在的唯一理由：`ATTACHMENT_TEXT` 曾经是个三档旋钮，而 `on` 那一路没有任何代码
 * 消费（`attachmentTextFeedsSummary()` 零调用者）—— 操作者改它毫无效果，注释还教人
 * 「跑一轮再转 on」。那就是 issue #58 专门删掉 `sources.schedule_config_json` 时定性的
 * 幽灵旋钮。所以接线之后，**第一件要证明的事就是这一档真的改变了产出**，否则第 5 步
 * 等于没做，而仓库里的三方缺省断言（代码 / .env.example / compose）也只是三个一致的空话。
 *
 * 覆盖的四件事：
 *   1. `shadow`：附件已抽好，但提示词不含条文 ⇒ 落库摘要**没有**条文要点，也不标记「已喂」；
 *   2. `on`：同一份库、同一条目，重跑之后条文要点出现，且每条都带**出处附件名**；
 *   3. 出处的引用确实逐字来自附件正文（不是模型编的，也不是公告壳里的话）；
 *   4. `fed_to_summary` 只在摘要真的用上时才置位 —— 详情页那句「本站读到的条文」
 *      靠它说话，标记错了就是界面在撒谎。
 *
 * 零外部依赖（ADR-0001）：临时 SQLite + stub LLM，不起 web、不出网。
 */

const NOTICE_ID = 'a'.repeat(32);
const ATTACHMENT_NAME = '某某管理办法（草案征求意见稿）.pdf';
const ATTACHMENT_URL = 'https://attachments.test/draft.pdf';

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 1..30 的中文序数 —— 条文锚点是「第X条」，阿拉伯数字写法不保证被识别。 */
function cnNumber(value) {
  if (value < 10) return CN_DIGITS[value];
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return `${tens === 1 ? '' : CN_DIGITS[tens]}十${ones === 0 ? '' : CN_DIGITS[ones]}`;
}

/** 一份"够长、有结构、含受影响主体"的草案正文（超过 MIN_DRAFT_CJK_CHARS 才会被采信）。 */
const DRAFT_TEXT = [
  '某某管理办法（草案征求意见稿）',
  '第一条 为了规范某类活动的监督管理，依据有关法律、行政法规，制定本办法。',
  '第二条 在中华人民共和国境内从事下列活动的企业事业单位，应当遵守本办法。',
  ...Array.from({ length: 26 }, (unused, index) => {
    const ordinal = cnNumber(index + 3);
    return `第${ordinal}条 从事前款规定活动的单位应当建立全流程台账，并于每年一季度末前将上一年度的处理情况报送所在地主管部门，报送内容应当包括设施运行、污染物处置与应急处置演练三类记录。`;
  }),
].join('\n');

let workDir;
let dbFile;
let logs;
let summarizeJob;
let attachmentsRepo;
let noticesRepo;
let sourcesRepo;

const ctx = {
  logger: (message) => logs.push(message),
  now: () => new Date(),
};

/** 读某条公示的摘要 JSON（未生成时为 null）。 */
function summaryRow() {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db.prepare('select summary_status as status, ai_summary_json as json from notices where id = ?').get(NOTICE_ID);
  } finally {
    db.close();
  }
}

/** 把摘要重置成「未生成」，模拟同一份条文在另一档位下重新生成一次。 */
function resetSummary() {
  const db = new Database(dbFile);
  try {
    db.prepare('update notices set summary_status = ?, ai_summary_json = null, summary_model = null').run('pending');
  } finally {
    db.close();
  }
}

async function runSummaryRound() {
  logs = [];
  await summarizeJob.run(ctx);
  return logs.join('\n');
}

/** 去空白后的包含判断 —— 与 buildQuotedSummary 的指纹口径一致。 */
function containsVerbatim(haystack, needle) {
  return haystack.replace(/\s+/g, '').includes(needle.replace(/\s+/g, ''));
}

before(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-draft-input-'));
  dbFile = path.join(workDir, 'app.db');
  process.env.DB_DRIVER = 'sqlite';
  process.env.DATABASE_URL = dbFile;
  process.env.LLM_PROVIDER = 'stub';
  process.env.MAILER_PROVIDER = 'stub';
  // 触发 migrations：首次取连接时自动建表（与各 e2e 同一手法）
  noticesRepo = await import('../../src/db/repo/notices.ts');
  attachmentsRepo = await import('../../src/db/repo/attachments.ts');
  sourcesRepo = await import('../../src/db/repo/sources.ts');
  summarizeJob = (await import('../../worker/jobs/summarize-notices.ts')).summarizeNoticesJob;

  await sourcesRepo.registerSource({
    id: 'e2e-draft-input',
    name: '条文输入测试源',
    adapterType: 'fixture',
  });
  await noticesRepo.upsertNotice({
    id: NOTICE_ID,
    sourceId: 'e2e-draft-input',
    title: '关于某某管理办法公开征求意见的公告',
    agency: '测试部',
    url: 'https://source.test/notice-1.html',
    publishedAt: '2026-09-20',
    deadlineAt: '2026-11-30',
    status: 'open',
    bodyText: '现就该管理办法向社会公开征求意见，请于截止日期前反馈。',
    attachments: [{ name: ATTACHMENT_NAME, url: ATTACHMENT_URL }],
    fetchedAt: new Date().toISOString(),
  });
  // 直接落到「已抽好条文」的状态：抽取过程本身由 attachment-extract-job.test.mjs 覆盖，
  // 这里要隔离的是**摘要读不读**这一件事，不该把下载与解析的不确定性混进来。
  await attachmentsRepo.syncAttachmentManifest({
    noticeId: NOTICE_ID,
    attachments: [{ name: ATTACHMENT_NAME, url: ATTACHMENT_URL }],
    now: new Date(),
  });
  await attachmentsRepo.markAttachmentResult(NOTICE_ID, ATTACHMENT_URL, {
    status: 'ok',
    kind: 'pdf',
    bytes: 4096,
    contentHash: 'e2e-draft-input',
    charCount: DRAFT_TEXT.replace(/\s+/g, '').length,
    extractedText: DRAFT_TEXT,
    fetchedAt: new Date(),
  });
});

after(() => {
  delete process.env.ATTACHMENT_TEXT;
  // 刻意不删临时目录：数据库连接是进程内单例，跑完仍持着文件句柄，
  // Windows 上 rmSync 会 EPERM（同一目录交回系统回收，与各 in-process e2e 一致）
});

describe('issue #57 第 5/6 步：附件条文进摘要（档位必须真的有效果）', () => {
  it('shadow：附件已抽好，但条文不进提示词 ⇒ 摘要里没有条文要点', async () => {
    process.env.ATTACHMENT_TEXT = 'shadow';
    const output = await runSummaryRound();
    assert.match(output, /摘要任务完成：成功 1 条/, 'shadow 档下摘要仍要正常生成');
    assert.ok(
      !/附件条文 \d+ 份/.test(output),
      '日志说「用到附件条文」就等于把没做的事说成做了（这条是界面上那句话的源头）',
    );

    const row = summaryRow();
    assert.equal(row.status, 'done');
    const summary = JSON.parse(row.json);
    assert.deepEqual(summary.keyPoints, [], '影子档不得产出条文要点 —— 页面一字不变才叫影子');
    assert.match(summary.what.text, /stub/, '其余各段照常生成（影子档不是把摘要也关掉）');

    const attachment = (await attachmentsRepo.listNoticeAttachments(NOTICE_ID))[0];
    assert.equal(attachment.fedToSummary, false, '没喂给摘要就不能标「已喂」（详情页那句话靠它）');
  });

  it('on：同一份库同一条目，重跑后条文要点出现、且带出处', async () => {
    process.env.ATTACHMENT_TEXT = 'on';
    resetSummary();
    const output = await runSummaryRound();
    assert.match(output, /附件条文 1 份/, '日志要说清这条摘要用了条文（生产排查全靠它）');
    assert.match(output, /档位 on/);

    const summary = JSON.parse(summaryRow().json);
    assert.ok(summary.keyPoints.length > 0, '给了条文却没有要点 ⇒ 第 5 步等于没接线');
    assert.equal(summary.keyPoints[0].source, ATTACHMENT_NAME, '要点必须标明来自哪个附件');
    assert.equal(summary.keyPoints[0].sourceUrl, ATTACHMENT_URL);
    for (const point of summary.keyPoints) {
      assert.ok(point.quote, '条文要点必须带引用');
      assert.ok(
        containsVerbatim(DRAFT_TEXT, point.quote),
        `引用不是条文的逐字片段：${point.quote}`,
      );
      assert.ok(
        !containsVerbatim('现就该管理办法向社会公开征求意见，请于截止日期前反馈。', point.quote),
        '引用应来自条文，不该是公告壳里的话',
      );
    }

    const attachment = (await attachmentsRepo.listNoticeAttachments(NOTICE_ID))[0];
    assert.equal(attachment.fedToSummary, true, '真的喂给摘要了才标记');
  });

  it('条文为空表（字数不足）时不喂要点，也不标记已喂', async () => {
    process.env.ATTACHMENT_TEXT = 'on';
    const tinyId = 'b'.repeat(32);
    await noticesRepo.upsertNotice({
      id: tinyId,
      sourceId: 'e2e-draft-input',
      title: '关于某某标准公开征求意见的公告',
      agency: '测试部',
      url: 'https://source.test/notice-2.html',
      publishedAt: '2026-09-21',
      deadlineAt: '2026-12-01',
      status: 'open',
      bodyText: '现就该标准向社会公开征求意见。',
      attachments: [{ name: '意见征求表.docx', url: 'https://attachments.test/form.docx' }],
      fetchedAt: new Date().toISOString(),
    });
    await attachmentsRepo.syncAttachmentManifest({
      noticeId: tinyId,
      attachments: [{ name: '意见征求表.docx', url: 'https://attachments.test/form.docx' }],
      now: new Date(),
    });
    await attachmentsRepo.markAttachmentResult(
      tinyId,
      'https://attachments.test/form.docx',
      {
        status: 'ok',
        kind: 'docx',
        bytes: 512,
        contentHash: 'e2e-blank-form',
        charCount: 40,
        extractedText: '姓名： 单位： 意见：',
        fetchedAt: new Date(),
      },
    );

    logs = [];
    await summarizeJob.run(ctx);
    const db = new Database(dbFile, { readonly: true });
    let row;
    try {
      row = db.prepare('select ai_summary_json as json from notices where id = ?').get(tinyId);
    } finally {
      db.close();
    }
    const summary = JSON.parse(row.json);
    assert.deepEqual(summary.keyPoints, [], '抽到的只是空白意见表，不该被当成条文喂进去');
    const stored = (await attachmentsRepo.listNoticeAttachments(tinyId))[0];
    assert.equal(stored.fedToSummary, false, '没喂就不该标「已喂」');
  });
});
