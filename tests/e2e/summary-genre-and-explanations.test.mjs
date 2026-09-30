import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';

import { describeDiagnostics, parseSummaryDiagnostics } from '../../src/lib/summary-diagnostics.ts';
import { countChangeMarkers, findChangeMarkers } from '../../src/lib/change-coverage.ts';
import { sentenceSpans } from '../../src/lib/change-table.ts';

/**
 * 端到端（issue #76 起步，issue #85 起只剩"体裁 + 编制说明要点"这两半）：
 * 一条决议体裁的公告，摘要该长成什么样。
 *
 * 这个文件原本还覆盖「修正案改动点表格」（每行带逐字原文、覆盖度分母按全文数）。
 * 那套功能已于 2026-09-27 **整体删除**（issue #85）：生产全库 `changes` 非空的条目
 * **0 条**，连最该产出它的 5 条候选在点名重跑之后也仍是 0 条 —— 一个从不渲染的分支，
 * 留着只会让每个后来者重新问一遍"它为什么不出现"。删掉的是写入侧与渲染侧，
 * **读侧的向后兼容单独在 `tests/unit/summary-shape.test.mjs` 里钉住**（旧行还带着
 * `changes` / `changeMarkers` 两个键，解析必须照常成功）。
 *
 * 剩下的两半都还有生产样本，所以留在这里端到端跑：
 *   1. **体裁判定的顺序**（"等2项"要先于"修正"命中）+ 弱证据不许覆盖强证据；
 *   2. **编制说明要点**：按说明自己的小节逐条落库，引用只出自说明（段落隔离走真路径）。
 *
 * 零外部依赖（ADR-0001）：临时 SQLite + stub LLM，不起 web、不出网。
 */

const EXPLANATION_NAME = '某某法（修正草案征求意见稿）编制说明.docx';
const EXPLANATION_URL = 'https://attachments.test/explain.docx';

/** 说明正文：六个小节（分母就数它们），且含一句条文正文里没有的「现行许可制度…」。 */
const EXPLANATION_TEXT = [
  '一、修订的必要性',
  '现行许可制度实施以来，申请材料重复提交的问题一直存在，基层反映办理周期偏长、跨地区互认困难，需要简化办理流程并明确各环节的时限要求与公开义务。',
  '二、编制过程与依据',
  '编制组系统梳理了有关现行法律与行政法规的规定，赴若干省份开展实地调研与座谈，书面征求主管部门、行业协会与专家的意见，在此基础上形成征求意见稿。',
  '三、主要修改内容',
  '增设一次性告知与限时办结要求，明确主管部门的公开义务，把监督检查结果纳入信用记录管理，并删除了实践中已无法执行的两项前置条件。',
  '四、征求意见的范围与处理方式',
  '本次公开征求意见面向各类经营主体与社会公众，收到的意见由编制组逐条研究，采纳情况在下次审议稿的说明中一并交代，未采纳的说明理由。',
  '五、预期效果与实施安排',
  '施行后预计办理材料可减少约三分之一，主管部门将同步公布配套的实施指南与问答，并对过渡期内已受理的申请按原规定继续办理完毕。',
  '六、其他需要说明的问题',
  '本标准与相关强制性标准的关系、涉及个人信息处理部分的衔接安排，已在附表中逐项列明，此处不再展开，相关条文以正文为准。',
].join('\n');

const AMENDED_ID = 'b'.repeat(32);
const FRESH_ID = 'c'.repeat(32);
/**
 * 打包清单（genre=package_plan）：标题里「等2项」**先于**「修正」命中，
 * 而它的附件恰恰是一份标准的修订对照文本 —— 也就是"模型完全有理由吐出一张改动点表"。
 *
 * 这条存在的唯一理由是让**体裁门可观测**：新案夹具里的改动词只能出现在编制说明里，
 * 而 `changes` 的逐字反查只认草案那一侧的段落（说明的话不许当"规定本身"落库），
 * 所以新案那条无论如何都产不出改动点 —— 撤掉体裁门它也不会红。
 * 2026-09-26 实测：`check-test-pins.mjs` 当场报「这条断言没钉住任何东西」，
 * 于是补了这条打包清单（生产里真有「等11项强制性国家标准」这种标题）。
 */
const PACKAGE_ID = 'e'.repeat(32);
const PACKAGE_TITLE = '关于征求《某某法》等2项法律草案（修正草案征求意见稿）意见的公告';
const PACKAGE_ATTACHMENT_URL = 'https://attachments.test/package.docx';
/**
 * 存量错判那条（回填用）：金丝雀《美丽河湖评价技术导则》的形状 ——
 * 一份**全新**标准，正文里只有一个「现行」（"现行标准未对…作出规定"），没有任何改动词。
 * 旧词表据此把它判成修正案（生产 22 条如此），收窄词表后它应当回到新案草案。
 */
const STALE_ID = 'f'.repeat(32);
const STALE_TITLE = '关于公开征求国家标准《美丽河湖评价技术导则（征求意见稿）》意见的通知';
const STALE_ATTACHMENT_URL = 'https://attachments.test/stale-guide.docx';
const STALE_TEXT = [
  '美丽河湖评价技术导则（征求意见稿）',
  '1 范围',
  '本文件规定了美丽河湖评价的指标体系、评价方法与评价程序，适用于指导各地开展美丽河湖建设成效评价。',
  '2 规范性引用文件',
  '下列文件中的内容通过文中的规范性引用而构成本文件必不可少的条款，凡是注日期的引用文件，仅该日期对应的版本适用于本文件。',
  '3 术语和定义',
  '现行标准未对水生生物完整性作出规定，本文件补充了该项指标及其赋分方法，并明确了数据来源与监测频次的要求。',
  '4 评价指标体系',
  '评价指标包括水环境质量、水生生物完整性、岸线生态缓冲带、公众满意度四类，各类指标的分值权重与赋分细则见附录 A。',
  '5 评价方法与程序',
  '评价工作由省级生态环境主管部门组织，按资料收集、现场调查、指标赋分、结果校核四个步骤开展，评价周期为三年一次。',
].join('\n');
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

const FRESH_EXPLANATION_NAME = '某某决定（草案征求意见稿）编制说明.docx';
const FRESH_EXPLANATION_URL = 'https://attachments.test/fresh-explain.docx';

/**
 * 新案那份编制说明：**里面故意留了一句"改动词"**（"与现行做法相比，删去了…"）。
 *
 * 这不是随手加的长度填充，而是让**体裁门真的可观测**所必需的夹具：
 * stub 的回响规则是"条文里出现可计数的改动词（修改为 / 删去 / 增加一条）就产出一条改动点"，
 * 而"新案不该长出一张改动点表"这道门（`summarize-notices.ts`）拦的正是那种产出。
 * 夹具里没有这样一行时，撤掉那道门不会有任何可观测差异 —— 2026-09-26 实测：
 * 这条 pin 退化成"撤了也不红"（`check-test-pins.mjs` 报「这条断言没钉住任何东西」）。
 * 而真实的误判形状就是它：一份新案草案自己的说明里在讲"相比现行做法删去了什么"，
 * 模型据此吐出一张"改动点"表 —— 一份首次制定的文件没有"改了哪几处"可言。
 * 另：这份说明里的「现行」同时也是 #79 的回归位（它不再是体裁信号）。
 */
const FRESH_EXPLANATION_TEXT = [
  '一、制定的必要性',
  '现行做法下同类事项由各部门分别受理，申请人需要重复提交材料，办理周期偏长，基层反映较为集中。',
  '二、主要思路与主要修改',
  '本决定为首次制定。与现行做法相比，删去了实践中已无法执行的两项前置条件，把办理时限、公开义务与监督方式一并写入条文。',
  '三、征求意见的范围',
  '本次公开征求意见面向各类经营主体与社会公众，收到的意见逐条研究，采纳情况在后续说明中一并交代。',
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
      .prepare(
        'select summary_status as status, ai_summary_json as json, ' +
          'summary_diagnostics_json as diagnostics from notices where id = ?',
      )
      .get(id);
    return {
      status: row?.status ?? null,
      json: row?.json ? JSON.parse(row.json) : null,
      diagnostics: row?.diagnostics ? JSON.parse(row.diagnostics) : null,
    };
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
    attachments: [
      { name: ATTACHMENT_NAME, url: ATTACHMENT_URL },
      { name: EXPLANATION_NAME, url: EXPLANATION_URL },
    ],
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
    attachments: [
      { name: ATTACHMENT_NAME, url: FRESH_ATTACHMENT_URL },
      // 说明那份是**为了让"新案不该有改动点"这道门可观测**而故意留的（见上面那段说明）
      { name: FRESH_EXPLANATION_NAME, url: FRESH_EXPLANATION_URL },
    ],
    fetchedAt: new Date().toISOString(),
  });

  await noticesRepo.upsertNotice({
    id: PACKAGE_ID,
    sourceId: 'e2e-amendment',
    title: PACKAGE_TITLE,
    agency: '测试部',
    url: 'https://source.test/package.html',
    publishedAt: '2026-09-20',
    deadlineAt: '2026-11-30',
    status: 'open',
    bodyText: '现就这2项法律草案公开征求意见，请于截止日期前反馈。',
    attachments: [{ name: ATTACHMENT_NAME, url: PACKAGE_ATTACHMENT_URL }],
    fetchedAt: new Date().toISOString(),
  });

  await noticesRepo.upsertNotice({
    id: STALE_ID,
    sourceId: 'e2e-amendment',
    title: STALE_TITLE,
    agency: '测试部',
    url: 'https://source.test/stale.html',
    publishedAt: '2026-09-20',
    deadlineAt: '2026-11-30',
    status: 'open',
    bodyText: '现就该国家标准公开征求意见，请于截止日期前反馈。',
    attachments: [{ name: ATTACHMENT_NAME, url: STALE_ATTACHMENT_URL }],
    fetchedAt: new Date().toISOString(),
  });

  const FIXTURE_FILES = [
    { noticeId: AMENDED_ID, name: ATTACHMENT_NAME, url: ATTACHMENT_URL, text: AMENDED_TEXT },
    { noticeId: AMENDED_ID, name: EXPLANATION_NAME, url: EXPLANATION_URL, text: EXPLANATION_TEXT },
    { noticeId: FRESH_ID, name: ATTACHMENT_NAME, url: FRESH_ATTACHMENT_URL, text: FRESH_TEXT },
    {
      noticeId: FRESH_ID,
      name: FRESH_EXPLANATION_NAME,
      url: FRESH_EXPLANATION_URL,
      text: FRESH_EXPLANATION_TEXT,
    },
    // 打包清单那条复用同一份"修订对照"正文：它就是要让模型有理由吐出改动点
    { noticeId: PACKAGE_ID, name: ATTACHMENT_NAME, url: PACKAGE_ATTACHMENT_URL, text: AMENDED_TEXT },
    // 存量错判那条（回填用）：正文里只有「现行」，一个字都没改过现行文本
    { noticeId: STALE_ID, name: ATTACHMENT_NAME, url: STALE_ATTACHMENT_URL, text: STALE_TEXT },
  ];
  // 清单必须**按公示一次给全**：syncAttachmentManifest 会把本轮清单里没有的行撤下，
  // 一个附件调一次就会把先写进去的那份正文删掉（我第一版踩在这里，表现为整条没喂进摘要）。
  for (const noticeId of new Set(FIXTURE_FILES.map((file) => file.noticeId))) {
    const files = FIXTURE_FILES.filter((file) => file.noticeId === noticeId);
    await attachmentsRepo.syncAttachmentManifest({
      noticeId,
      attachments: files.map((file) => ({ name: file.name, url: file.url })),
      now: new Date(),
    });
    for (const file of files) {
      await attachmentsRepo.markAttachmentResult(noticeId, file.url, {
        status: 'ok',
        kind: 'docx',
        bytes: 4096,
        contentHash: `e2e-${file.url}`,
        charCount: file.text.replace(/\s+/g, '').length,
        extractedText: file.text,
        fetchedAt: new Date(),
      });
    }
  }

  logs = [];
  await summarizeJob.run(ctx);
});

after(() => {
  delete process.env.ATTACHMENT_TEXT;
  // 刻意不删临时目录：进程内 SQLite 连接仍持句柄，Windows 上 rmSync 会 EPERM（与各 e2e 一致）
});

describe('issue #76：体裁判定的两个现场（摘要形状的入口）', () => {
  it('入库时按标题就判成修正案，且依据写明是标题证据', () => {
    const row = readGenre(AMENDED_ID);
    assert.equal(row.genre, 'amendment');
    assert.match(row.basis, /修正|修订/);
  });

  it('正文里有"现行"二字不等于修正案（#79 的金丝雀形状）', () => {
    const row = readGenre(FRESH_ID);
    assert.equal(row.genre, 'new_draft', `新案不该被措辞带跑，实际依据：${row.basis}`);
    const { json } = readSummary(FRESH_ID);
    // 前提断言：新案的条文**确实喂进去了**（有条文要点），所以"体裁没被判错"这件事
    // 不是因为"什么都没喂"。夹具正文够长就是为了这个（见 FRESH_TEXT 的长度注释）。
    assert.ok(
      json.keyPoints.length > 0,
      '新案正文必须够长并被喂进摘要，否则这条用例退化成"因为没喂所以没内容"的假绿灯',
    );
  });

  it('打包清单先于「修正」命中（顺序错了全站打包标准会被吞进修正案）', () => {
    const row = readGenre(PACKAGE_ID);
    assert.equal(row.genre, 'package_plan', `「等2项」要先于「修正」命中，实际依据：${row.basis}`);
    const { json } = readSummary(PACKAGE_ID);
    assert.ok(json, `打包清单这条也应生成摘要，日志：${logs.join('\n').slice(-400)}`);
    // 前提：附件确实喂进去了 —— 否则上面那句"判成打包清单"只是"没喂"的副产品
    assert.ok(json.keyPoints.length > 0, '这份对照正文必须够长并被喂进摘要');
  });

  it('编制说明按自己的小节逐条落库，且引用只出自说明（段落隔离走真路径）', () => {
    const { json } = readSummary(AMENDED_ID);
    assert.ok(json.explanationPoints.length >= 2, `说明该有要点，实际 ${json.explanationPoints.length} 条`);
    for (const point of json.explanationPoints) {
      assert.equal(
        containsVerbatim(EXPLANATION_TEXT, point.quote),
        true,
        `说明要点的引用必须出自说明，实际：${point.quote}`,
      );
      assert.equal(point.source, EXPLANATION_NAME, '出处要指向说明那份附件');
      assert.ok(point.heading.length > 0, '小节标题要照抄说明自己的写法');
    }
    // 反方向也要成立：条文要点不能借说明里的句子（那句"现行许可制度…"只在说明里）
    for (const point of json.keyPoints) {
      assert.equal(
        containsVerbatim(AMENDED_TEXT, point.quote),
        true,
        `条文要点必须出自条文正文，实际：${point.quote}`,
      );
    }
    assert.equal(json.explanationSections, 6, '分母按说明全文数出的小节数');
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

/**
 * issue #79：改了词表之后，存量怎么改过来 —— 这一组复刻生产那 22 条的真实状态。
 *
 * 它们存的是 `genre=amendment` + `genre_evidence=attachment_text` + 依据那句话
 * 「附件正文含对照措辞「现行」」。收窄词表后重算出来是**标题级证据**（rank 1 < 3），
 * 于是「弱证据不许覆盖强证据」这条守则把它原样挡住 ⇒ **一条都改不动**，
 * 5 条本该是新案草案的条目会继续挂着「修正案」角标、继续用修正案模板。
 * `force` 就是为"输入本身变了"（词表换了）准备的门 —— 它不改判据，只承认旧的"强证据"
 * 已经是一条过期结论。
 *
 * 放文件末尾：这一组会写库改体裁，跑在前面的断言依赖 before 里那份初始状态。
 */
describe('issue #79：改词表后的存量回填', () => {
  /** 把这条置回"旧词表判出来的样子"。生产就是这么存的，所以只能直接写库复刻。 */
  function makeStale() {
    const db = new Database(dbFile);
    try {
      db.prepare(
        "update notices set genre = 'amendment', genre_evidence = 'attachment_text', " +
          "genre_basis = '附件正文含对照措辞「现行」' where id = ?",
      ).run(STALE_ID);
    } finally {
      db.close();
    }
  }

  it('不带 force：覆盖规矩把改动全挡掉（这正说明它救不了词表变更）', async () => {
    makeStale();
    const { backfillNoticeGenres } = await import('../../src/db/repo/notices.ts');
    const report = await backfillNoticeGenres({ apply: true });
    assert.ok(report.skipped > 0, `应有条目被覆盖规矩跳过，实际 ${report.skipped} 条`);
    assert.ok(
      !report.samples.some((row) => row.id === STALE_ID),
      '它不该出现在"本次改写"名单里 —— 旧证据是 attachment_text，重算出来的 title 比它弱',
    );
    const row = readGenre(STALE_ID);
    assert.equal(row.genre, 'amendment', '没带 force ⇒ 错判原样留着（这就是要 force 的原因）');
    assert.match(row.basis, /现行/, '依据也还是那句已经不成立的话');
  });

  it('带 force：按当前词表重算，回到新案草案，依据同时换掉', async () => {
    const { backfillNoticeGenres } = await import('../../src/db/repo/notices.ts');

    const dry = await backfillNoticeGenres({ apply: false, force: true });
    const sample = dry.samples.find((row) => row.id === STALE_ID);
    assert.ok(sample, 'force 之后它应当出现在改写名单里（dry-run 也必须看得见）');
    assert.equal(sample.from, 'amendment');
    assert.equal(sample.to, 'new_draft');
    assert.equal(readGenre(STALE_ID).genre, 'amendment', 'dry-run 绝不写库');

    await backfillNoticeGenres({ apply: true, force: true });
    const after = readGenre(STALE_ID);
    assert.equal(after.genre, 'new_draft', '一份全新标准不该再挂着「修正案」角标');
    assert.equal(after.evidence, 'title');
    // 依据要换成新算出来的那句（"标题含「导则」且无改现行文本的迹象"—— 注意它本身就带
    // 「现行」二字，所以判据是"不再声称正文里有对照措辞"，不是"不含现行"）
    assert.doesNotMatch(after.basis, /对照措辞/, '依据里不许再留着那句已经不算数的话');
    assert.equal(after.basis, '标题含「导则」且无改现行文本的迹象');

    // 幂等：再跑一次不该又"改写"一遍（算出来与存量逐字相同就不写）
    const again = await backfillNoticeGenres({ apply: true, force: true });
    assert.ok(
      !again.samples.some((row) => row.id === STALE_ID),
      'force 也要幂等：第二次跑它不该再出现在改写名单里',
    );
  });
});

/**
 * issue #86 第 0 刀：**这一次调用的诊断跟着摘要一起落库**。
 *
 * 为什么值得一条端到端：删掉的「改动点」连续两轮零产出，而事后没有任何人能回答它是
 * "模型返回了空数组"还是"引用反查不过被丢掉"（#79）。这条测试钉的是那条信息**真的
 * 走完了全链路**：worker 合成 → 写库 → 读回来能解析 → 与摘要本体的条数对得上。
 *
 * 顺带它也覆盖了迁移 0019：这个库是迁移建出来的，列不存在时 `saveNoticeSummary` 会抛，
 * 于是本文件所有摘要断言一起变红 —— 不需要为"列加上了没有"单写一条。
 */
describe('issue #86：摘要调用的诊断随摘要落库', () => {
  it('诊断写下来了，且与摘要本体的条数逐项对得上', () => {
    const { json, diagnostics } = readSummary(AMENDED_ID);
    assert.ok(json, '前置：这一条应当已经有摘要');
    assert.ok(diagnostics, '摘要落库时必须同时写下这一次调用的诊断');
    const parsed = parseSummaryDiagnostics(diagnostics);
    assert.ok(parsed, '落库的诊断要能被读侧解析');
    assert.equal(parsed.model, 'stub', '模型名与端口名来自 worker 当轮算出来的那一个');
    assert.equal(parsed.provider, 'stub');
    assert.equal(parsed.attempts, 1, '一次就成 —— 重试次数此前只写在 stdout 里');
    // 最要紧的一条：诊断说的"落库几条"必须与摘要本体一致，否则诊断是在自说自话
    assert.deepEqual(parsed.kept, {
      keyPoints: json.keyPoints.length,
      explanationPoints: json.explanationPoints.length,
      channels: json.channels.length,
      impacts: json.impacts.length,
      changes: json.changes.length,
    });
  });

  it('端口没上报响应细节 ⇒ 明说"没人看过"，不把未上报写成"模型什么都没说"', () => {
    const { diagnostics } = readSummary(AMENDED_ID);
    const parsed = parseSummaryDiagnostics(diagnostics);
    // stub 不产出诊断，所以响应类字段一律为空 —— 但**落库条数**仍然是真的
    assert.equal(parsed.instrumented, false);
    assert.equal(parsed.elapsedMs, null, '"没测"不能写成"0 毫秒"');
    assert.equal(parsed.finishReason, null);
    assert.equal(parsed.rawChars, 0);
    assert.equal(parsed.raw, '');
    assert.match(
      describeDiagnostics(parsed),
      /端口未上报响应细节/,
      '读的人必须一眼看出"没人看过"，而不是以为模型什么都没说',
    );
  });

  it('人工录入的摘要没有调用可描述 ⇒ 清空这一列，不留上一轮的假证据', async () => {
    const { saveNoticeSummary } = await import('../../src/db/repo/summaries.ts');
    const before = readSummary(FRESH_ID);
    assert.ok(before.diagnostics, '前置：这条原本带着诊断');

    await saveNoticeSummary({
      id: FRESH_ID,
      summaryJson: JSON.stringify(before.json),
      summaryModel: 'manual',
      diagnosticsJson: null,
    });

    const after = readSummary(FRESH_ID);
    assert.equal(after.status, 'done');
    assert.equal(after.diagnostics, null, '人写的摘要不该挂着一份模型调用的诊断');
  });
});

/**
 * issue #86 第 1 刀：影响判读（全站唯一允许推断的一段）走完真实链路。
 *
 * 这里钉的是**落库这一侧**：模型（stub）吐出的判读必须逐条挂上程序反查出来的出处，
 * 且诊断要能说清吐了几条、留下几条。渲染侧（含受众面门控）在
 * `notice-genre-badge.test.mjs` 里钉 —— 那条路要真取页面。
 */
describe('issue #86：影响判读落库时每条都挂着可核对的原文', () => {
  it('判读落库了，每条都有逐字引用与程序反查出来的出处', () => {
    const { json } = readSummary(AMENDED_ID);
    assert.ok(json.impacts.length > 0, '给了附件条文就该有判读（stub 的回响与模型同一条路径）');
    for (const impact of json.impacts) {
      assert.ok(impact.quote.length >= 8, '引用要够长才构成可核对的出处');
      assert.ok(
        containsVerbatim(`${AMENDED_TEXT}\n${EXPLANATION_TEXT}`, impact.quote),
        `判读的引用必须逐字来自喂进去的附件：${impact.quote}`,
      );
      assert.ok(impact.source, '出处是程序反查出来的，不许为空');
      assert.ok(impact.text.length > 0);
      assert.ok(['risk', 'loophole', 'burden', 'other'].includes(impact.kind));
    }
  });

  it('诊断里数得出"吐了几条、留下几条"（判读也一样过逐字反查）', () => {
    const { json, diagnostics } = readSummary(AMENDED_ID);
    const parsed = parseSummaryDiagnostics(diagnostics);
    assert.equal(parsed.kept.impacts, json.impacts.length, '诊断说的落库条数要与摘要本体一致');
    if (parsed.instrumented) {
      assert.ok(parsed.emitted.impacts >= parsed.kept.impacts, '吐出的条数不可能少于落库的条数');
    }
  });
});

/**
 * issue #86 第 2 刀：「改了哪几处」走完真实链路。
 *
 * 这一段是**重建**（#85 删过、#86 按实测装回来），所以这里钉的不只是"能产出"，
 * 还有**与旧实现不同的那几处地基**：引用池是全部附件（不含 role 过滤）、
 * 不再有体裁门控、覆盖度分母从全文算。
 */
describe('issue #86：改动点落库（引用池与覆盖度分母）', () => {
  it('改动点落库了，每行都有逐字引用与程序反查出来的出处', () => {
    const { json } = readSummary(AMENDED_ID);
    assert.ok(json.changes.length > 0, '给了带改动词的正文就该有改动点');
    for (const change of json.changes) {
      assert.ok(
        containsVerbatim(`${AMENDED_TEXT}\n${EXPLANATION_TEXT}`, change.quote),
        `改动点的引用必须逐字来自喂进去的附件：${change.quote}`,
      );
      assert.ok(change.source, '出处由程序反查，不许为空');
      assert.ok(change.text.length > 0);
    }
  });

  it('覆盖度分母数的是全文，不是喂进去的那一截（且不小过表里的行数）', () => {
    const { json } = readSummary(AMENDED_ID);
    const expected = countChangeMarkers(`${AMENDED_TEXT} ${EXPLANATION_TEXT}`);
    assert.ok(json.changeMarkers, '分母要落库，否则页面那行覆盖度说不了话');
    assert.equal(json.changeMarkers.total, expected.total, '与 countChangeMarkers 同一判据');
    assert.ok(
      json.changes.length <= json.changeMarkers.total,
      '表里的行数不可能多过正文里数得到的表述数（多了就是模型在编）',
    );
  });

  it('体裁不门控产品形状：打包清单同样能产出改动点（#79 那个空栏的成因已移除）', () => {
    const { json } = readSummary(PACKAGE_ID);
    // 这条是**为这件事专门造的夹具**：体裁 package_plan，而附件是一份标准的修订对照文本。
    // 旧的 `genre !== 'amendment'` 那道门会把它的改动点全部清空（随之而来的就是 #79 那个
    // "标题写着改动点、正文说没检测到"的空栏）。今天的判据是"有没有可核对的依据"。
    assert.equal(readGenre(PACKAGE_ID).genre, 'package_plan', '前提：它确实不是修正案');
    assert.ok(
      json.changes.length > 0,
      '判据是"有没有可核对的依据"，不是"体裁标签等不等于修正案"',
    );
    assert.ok(json.changes[0].source, '每行仍要由程序反查出出处');
  });

  /**
   * issue #86 第二十节第 3 小节：那张表**落库了没有**，以及它的形状对不对。
   *
   * 为什么在 e2e 里钉这一处：造表的是 worker（`worker/jobs/summarize-notices.ts`），
   * 而 e2e 的 worker 子进程跑的就是源码 —— 撤掉"把表写进 JSON"这一行，这里当场变红；
   * 换成单测就钉不住（单测是自己调 `buildChangeTable`，验证不了"有没有落库"）。
   *
   * 判据一律 import 管线自己的实现（`sentenceSpans` / `findChangeMarkers` / `countChangeMarkers`），
   * 脚本里不另写一份 —— 这一段要回答的是"表与它声称覆盖的那些句子，是不是同一份判据算出来的"。
   */
  it('改动表连同"缺口"一起落库，且行序与句子全部对得上（行由程序定）', () => {
    const { json } = readSummary(AMENDED_ID);
    assert.ok(json.changeTable, '表必须落库：它是页面上"行由程序定"的唯一依据');
    const text = `${AMENDED_TEXT} ${EXPLANATION_TEXT}`;
    const withMarkers = sentenceSpans(text)
      .map((span) => text.slice(span.start, span.end).trim())
      .filter((sentence) => sentence !== '' && findChangeMarkers(sentence).length > 0);

    const entries = json.changeTable.entries;
    const described = entries.filter((entry) => entry.type === 'described');
    const factOnly = entries.filter((entry) => entry.type === 'fact');
    assert.equal(described.length, json.changes.length, '每一行改动说明都要在表里有位置，且只出现一次');
    assert.deepEqual(
      [...described.map((entry) => entry.change)].sort((a, b) => a - b),
      json.changes.map((_, index) => index),
      '下标覆盖 0..n-1 各一次：少一个就是有一行说明被表丢了',
    );
    assert.ok(factOnly.length > 0, '这份夹具里有一句改动表述没有任何一行覆盖它（说明里那句"删除了…"）');
    for (const entry of factOnly) {
      assert.ok(
        countChangeMarkers(entry.sentence).total > 0,
        `只报事实的行必须真的数到了改动表述：${entry.sentence}`,
      );
      assert.ok(containsVerbatim(text, entry.sentence), '那一行印的原文必须逐字来自我们读到的正文');
    }
    assert.equal(
      entries.length + json.changeTable.headers,
      withMarkers.length,
      '表里的行 + 不单独成行的标题句 = 正文里所有带改动表述的句子（多一句少一句都是漏）',
    );
  });
});
