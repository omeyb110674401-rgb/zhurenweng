import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';

/**
 * 端到端（issue #76 第 2 刀）：修正案的**改动点表格**要有产出，而且每一行都得能核对。
 *
 * 这块最容易骗人的地方有两处，断言各自钉一处：
 *   1. 表格里的"改了什么"是模型写的一句话 —— 它本身不可核对。所以每行必须带着
 *      **逐字原文**，且那句原文真的在附件正文里（`quote` 反查不到就整行丢弃）；
 *   2. 那行覆盖度的分母必须来自**全部**附件正文。如果拿喂给模型的那一截去数，
 *      窗口外的改动永远不会出现在"还差多少"里 —— 那个数字就成了自证，而不是证据。
 *
 * 顺带钉体裁闸门：正文里有"现行"这种词并不构成修正案 —— 判据是 genre，
 * 新案条目不该凭空长出一张改动点表。
 *
 * 零外部依赖（ADR-0001）：临时 SQLite + stub LLM，不起 web、不出网。
 */

const AMENDED_ID = 'b'.repeat(32);
const FRESH_ID = 'c'.repeat(32);
const ATTACHMENT_NAME = '某某法（修正草案征求意见稿）.docx';
const ATTACHMENT_URL = 'https://attachments.test/amend.docx';
const FRESH_ATTACHMENT_URL = 'https://attachments.test/fresh.docx';

/** 一份带成文修改表述的对照正文（stub 会照原行逐字摘成改动点的 quote）。 */
const AMENDED_TEXT = [
  '某某法（修正草案征求意见稿）',
  '第一条 为了规范某类活动，制定本法。',
  '第二条修改为：从事前款活动应当取得许可，并接受年度检查。',
  '删去第七条第二款。',
  '增加一条，作为第二十条：主管部门应当建立信用记录制度，记录期限不少于三年。',
  '第三条 现行有关管理规定与本法不一致的，适用本法。',
  '第四条 本法自公布之日起施行，相关规定同时废止并依照新的目录执行。',
  // 采信门槛是 MIN_DRAFT_CJK_CHARS = 400 汉字，所以要凑够长度。下面这些行刻意**不含**
  // 任何修改措辞 —— 否则"正文里检测到 N 处"就成了夹具的副产品，测不出真东西。
  '第五条 相关主体应当按照公布的条件开展活动，并在规定期限内报送年度情况说明与相应的材料清单，接受主管部门的监督检查。',
  '第六条 主管部门应当建立信息共享机制，及时归集并公布许可、处罚与监督检查记录，供社会公众查询。',
  '第七条 开展前款活动应当制定应急预案，并每年组织演练，演练情况应当形成书面记录备查。',
  '第八条 对违反本法规定的行为，任何单位和个人有权向主管部门举报，主管部门应当及时核实处理。',
  '第九条 主管部门应当依法公开行政许可的办理条件、程序、期限与结果，接受社会监督。',
  '第十条 相关行业协会应当加强行业自律，引导会员依法经营，并及时反映会员的合理诉求。',
].join('\n');

/** 一份新案正文：里面也出现了"现行"这个词，但它不是修正案。 */
const FRESH_TEXT = [
  '某某决定（草案征求意见稿）',
  '第一条 为规范相关活动，依据现行法律制定本决定，全体参与者应当遵守相关规定要求。',
  '第二条 参与者应当按照公布的条件提出申请并按期提交补充材料。',
  '第三条 主管部门应当公开办理条件、程序与期限，并及时反馈审查结果与理由说明。',
  '第四条 参与者对处理决定不服的，可以依法申请复核，复核期间不停止执行。',
  '第五条 主管部门应当建立信用记录制度，记录期限不少于三年，并与相关部门共享。',
  '第六条 相关活动应当接受年度检查，检查情况应当向社会公布并接受监督。',
  // 长度是门槛：正文不到 MIN_DRAFT_CJK_CHARS 就不会被喂进摘要，那时"新案不该有改动点"
  // 会**因为压根没喂而通过** —— 假绿灯。所以这份正文必须够长，让断言真的在测体裁闸门。
  '第七条 主管部门应当建立举报处理制度，对实名举报优先办理并及时向举报人反馈处理结果与理由。',
  '第八条 相关主体应当按照技术标准开展检测活动，并对出具的数据与报告的真实性与准确性负责。',
  '第九条 主管部门应当会同有关部门建立联合监管机制，实现许可、处罚与检查信息的实时归集共享。',
  '第十条 参与者应当依照本决定办理相关手续并提交必要材料，配合完成现场核查与资料核验工作。',
  '第十一条 本决定规定的期限以工作日计算，不含法定节假日；逾期提出的申请应当当场告知补正。',
].join('\n');

let workDir;
let dbFile;
let logs;
let summarizeJob;
let noticesRepo;
let attachmentsRepo;
let sourcesRepo;

const ctx = { logger: (message) => logs.push(message), now: () => new Date() };

function readSummary(id) {
  const db = new Database(dbFile, { readonly: true });
  try {
    const row = db
      .prepare('select summary_status as status, ai_summary_json as json from notices where id = ?')
      .get(id);
    return { status: row?.status ?? null, json: row?.json ? JSON.parse(row.json) : null };
  } finally {
    db.close();
  }
}

function readGenre(id) {
  const db = new Database(dbFile, { readonly: true });
  try {
    const row = db
      .prepare('select genre, genre_basis as basis, genre_evidence as evidence from notices where id = ?')
      .get(id);
    return row ?? null;
  } finally {
    db.close();
  }
}

function containsVerbatim(haystack, needle) {
  return haystack.replace(/\s+/g, '').includes(needle.replace(/\s+/g, ''));
}

before(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-amendment-'));
  dbFile = path.join(workDir, 'app.db');
  process.env.DB_DRIVER = 'sqlite';
  process.env.DATABASE_URL = dbFile;
  process.env.LLM_PROVIDER = 'stub';
  process.env.MAILER_PROVIDER = 'stub';
  process.env.ATTACHMENT_TEXT = 'on';

  noticesRepo = await import('../../src/db/repo/notices.ts');
  attachmentsRepo = await import('../../src/db/repo/attachments.ts');
  sourcesRepo = await import('../../src/db/repo/sources.ts');
  summarizeJob = (await import('../../worker/jobs/summarize-notices.ts')).summarizeNoticesJob;

  await sourcesRepo.registerSource({
    id: 'e2e-amendment',
    name: '修正案测试源',
    adapterType: 'fixture',
  });
  await noticesRepo.upsertNotice({
    id: AMENDED_ID,
    sourceId: 'e2e-amendment',
    title: '关于《中华人民共和国某某法（修正草案征求意见稿）》公开征求意见的公告',
    agency: '测试部',
    url: 'https://source.test/amend.html',
    publishedAt: '2026-09-20',
    deadlineAt: '2026-11-30',
    status: 'open',
    bodyText: '现就该法修正草案公开征求意见，请于截止日期前反馈。',
    attachments: [{ name: ATTACHMENT_NAME, url: ATTACHMENT_URL }],
    fetchedAt: new Date().toISOString(),
  });
  await noticesRepo.upsertNotice({
    id: FRESH_ID,
    sourceId: 'e2e-amendment',
    title: '关于《某某决定（草案征求意见稿）》公开征求意见的公告',
    agency: '测试部',
    url: 'https://source.test/fresh.html',
    publishedAt: '2026-09-20',
    deadlineAt: '2026-11-30',
    status: 'open',
    bodyText: '现就该决定草案公开征求意见，请于截止日期前反馈。',
    attachments: [{ name: ATTACHMENT_NAME, url: FRESH_ATTACHMENT_URL }],
    fetchedAt: new Date().toISOString(),
  });

  for (const [noticeId, url, text] of [
    [AMENDED_ID, ATTACHMENT_URL, AMENDED_TEXT],
    [FRESH_ID, FRESH_ATTACHMENT_URL, FRESH_TEXT],
  ]) {
    await attachmentsRepo.syncAttachmentManifest({
      noticeId,
      attachments: [{ name: ATTACHMENT_NAME, url }],
      now: new Date(),
    });
    await attachmentsRepo.markAttachmentResult(noticeId, url, {
      status: 'ok',
      kind: 'docx',
      bytes: 4096,
      contentHash: `e2e-${noticeId}`,
      charCount: text.replace(/\s+/g, '').length,
      extractedText: text,
      fetchedAt: new Date(),
    });
  }

  logs = [];
  await summarizeJob.run(ctx);
});

after(() => {
  delete process.env.ATTACHMENT_TEXT;
  // 刻意不删临时目录：进程内 SQLite 连接仍持句柄，Windows 上 rmSync 会 EPERM（与各 e2e 一致）
});

describe('issue #76 第 2 刀：修正案改动点', () => {
  it('入库时按标题就判成修正案，且依据写明是标题证据', () => {
    const row = readGenre(AMENDED_ID);
    assert.equal(row.genre, 'amendment');
    assert.match(row.basis, /修正|修订/);
  });

  it('摘要里出现了改动点，每一行的原文都逐字来自附件正文', () => {
    const { json } = readSummary(AMENDED_ID);
    assert.ok(json, `摘要应落库，日志：${logs.join('\n').slice(-800)}`);
    assert.ok(Array.isArray(json.changes) && json.changes.length > 0, '修正案应产出改动点');
    for (const change of json.changes) {
      assert.ok(change.quote.length > 0, '每行都要有逐字原文');
      assert.equal(
        containsVerbatim(AMENDED_TEXT, change.quote),
        true,
        `quote 必须真的在附件正文里，实际：${change.quote}`,
      );
      assert.equal(change.source, ATTACHMENT_NAME, '出处由程序反查，不能是模型自报');
    }
  });

  it('覆盖度分母数的是全文，不是喂进去的那一截', async () => {
    const { countChangeMarkers } = await import('../../src/lib/amendment-coverage.ts');
    const { json } = readSummary(AMENDED_ID);
    const expected = countChangeMarkers(AMENDED_TEXT);
    assert.equal(json.changeMarkers.total, expected.total, '分母必须等于全文里数到的数量');
    assert.ok(
      json.changes.length <= expected.total,
      '列出的行数不该超过分母 —— 超过了就是页面在宣称"看到了比正文更多的改动"',
    );
  });

  it('正文里有"现行"二字不等于修正案：新案条目不长出这张表', () => {
    const row = readGenre(FRESH_ID);
    assert.equal(row.genre, 'new_draft', `新案不该被措辞带跑，实际依据：${row.basis}`);
    const { json } = readSummary(FRESH_ID);
    // 这条断言是上面那条的意义所在：新案的条文**确实喂进去了**（有条文要点），
    // 所以"没有改动点"只能是体裁闸门的结果，而不是"没喂所以本来就没有"。
    assert.ok(
      json.keyPoints.length > 0,
      '新案正文必须够长并被喂进摘要，否则本用例退化成假绿灯（见夹具里那段长度注释）',
    );
    assert.equal(json.changeMarkers, null, '没判成修正案就不该有覆盖度');
    assert.deepEqual(json.changes, []);
  });

  it('抽取任务按正文把弱证据判定升级（标题没说修正、正文说了）', async () => {
    const id = 'd'.repeat(32);
    await noticesRepo.upsertNotice({
      id,
      sourceId: 'e2e-amendment',
      title: '关于《某某条例（征求意见稿）》公开征求意见的公告',
      agency: '测试部',
      url: 'https://source.test/quiet.html',
      publishedAt: '2026-09-21',
      deadlineAt: '2026-12-01',
      status: 'open',
      bodyText: '现就该条例修订草案公开征求意见。',
      attachments: [{ name: ATTACHMENT_NAME, url: 'https://attachments.test/quiet.docx' }],
      fetchedAt: new Date().toISOString(),
    });
    assert.equal(readGenre(id).genre, 'new_draft', '只有标题时它看起来就是份新草案');

    await attachmentsRepo.syncAttachmentManifest({
      noticeId: id,
      attachments: [{ name: ATTACHMENT_NAME, url: 'https://attachments.test/quiet.docx' }],
      now: new Date(),
    });
    await attachmentsRepo.markAttachmentResult(
      id,
      'https://attachments.test/quiet.docx',
      {
        status: 'ok',
        kind: 'docx',
        bytes: 2048,
        contentHash: 'quiet',
        charCount: AMENDED_TEXT.replace(/\s+/g, '').length,
        extractedText: AMENDED_TEXT,
        fetchedAt: new Date(),
      },
    );
    const { refreshNoticeGenreFromAttachments } = await import('../../src/db/repo/attachments.ts');
    const decision = await refreshNoticeGenreFromAttachments(id);
    assert.ok(decision, '正文级证据应当足以改写判定');
    assert.equal(decision.genre, 'amendment');
    assert.equal(readGenre(id).evidence, 'attachment_text');
  });
});
