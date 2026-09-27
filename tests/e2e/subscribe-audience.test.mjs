import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { startAppServer } from './helpers/app-server.mjs';

/**
 * 端到端（issue #84）：受众面进订阅规则 —— 它和其余三项**不是同一种关系**。
 *
 * 链路与 `subscription-scope.test.mjs` 同一形状（表单 → 提交端点 → 落库回读 → 提醒匹配），
 * 单独一个文件是因为这一刀的核心判据是"收窄"：混进那个文件会让它既有的封数断言
 * （"订全部的收到两条"）随订阅者数量变化，而那种断言一旦变成"数数"，测的就不是规则了。
 *
 * 三件必须端到端验的事：
 * 1. **只勾受众面**是一条能提交、能生效的完整订阅（"这类公示我都要"）；
 * 2. **勾了收窄就真的收窄** —— 关键词命中但受众面不符的条目一条都不发；
 * 3. **`scope='all'` 也受收窄**（"全部新公示，但我只看公众广域"必须是那个意思）。
 *
 * 零外部依赖（ADR-0001）：临时 SQLite + stub 邮件端口，不起数据库、不出网。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-sub-audience-'));
const dbFile = path.join(workDir, 'app.db');
const outboxFile = path.join(workDir, 'outbox.jsonl');

/** 标题按 audience.ts 的规则能判出公众广域（法律草案）。 */
const PUBLIC_TITLE = '关于《中华人民共和国噪声污染防治法（草案）》公开征求意见';
/** 同理判出行业专业（技术规程：读者是执行它的专业技术人员）。 */
const SECTOR_TITLE = '关于某行业技术规程公开征求意见的公告';

const publicId = '1a'.repeat(16);
const sectorId = '2b'.repeat(16);

let app;
let noticesRepo;
let subsRepo;
let remindersJob;
let logs;

const ctx = { logger: (message) => logs.push(message), now: () => new Date() };

function datePlusDays(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function readOutbox() {
  if (!fs.existsSync(outboxFile)) return [];
  return fs
    .readFileSync(outboxFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

const mailsTo = (email) => readOutbox().filter((mail) => mail.to === email);

async function confirmedSubscription(input) {
  const created = await subsRepo.upsertSubscriptionRules({ ...input, now: new Date() });
  const confirmed = await subsRepo.confirmSubscriptionByToken(created.subscription.confirmToken);
  assert.equal(confirmed, 'confirmed', `订阅 ${input.email} 应能确认成功`);
  return created.subscription;
}

/** 建一条 7 天后截止的「征求意见中」条目（受众面由标题按 audience.ts 的规则判出）。 */
async function seedNotice(id, title) {
  await noticesRepo.upsertNotice({
    id,
    sourceId: 'e2e-audience',
    title,
    agency: '测试部',
    url: `https://source.test/${id}.html`,
    publishedAt: datePlusDays(-1),
    deadlineAt: datePlusDays(7),
    status: 'open',
    categoryTags: [],
    bodyText: '现向社会公开征求意见，请于截止日期前反馈。',
    attachments: [],
    fetchedAt: new Date().toISOString(),
  });
}

function postSubscription(fields) {
  return fetch(`${app.url}/api/subscriptions`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

before(async () => {
  process.env.DB_DRIVER = 'sqlite';
  process.env.DATABASE_URL = dbFile;
  process.env.LLM_PROVIDER = 'stub';
  process.env.MAILER_PROVIDER = 'stub';
  process.env.MAILER_OUTBOX_FILE = outboxFile;
  process.env.SITE_URL = 'https://zw.test';
  process.env.APP_BASE_URL = 'https://zw.test';
  process.env.ATTACHMENT_TEXT = 'off';

  noticesRepo = await import('../../src/db/repo/notices.ts');
  subsRepo = await import('../../src/db/repo/subscriptions.ts');
  const sourcesRepo = await import('../../src/db/repo/sources.ts');
  remindersJob = (await import('../../worker/jobs/send-deadline-reminders.ts')).sendDeadlineRemindersJob;

  await sourcesRepo.registerSource({ id: 'e2e-audience', name: '受众面测试源', adapterType: 'fixture' });
  await seedNotice(publicId, PUBLIC_TITLE);
  await seedNotice(sectorId, SECTOR_TITLE);

  // 三条订阅，差别只在受众面这一栏：
  await confirmedSubscription({
    email: 'public-only@example.test',
    keywords: [],
    categories: [],
    agencies: [],
    audiences: ['public'],
    scope: 'rules',
  });
  await confirmedSubscription({
    email: 'all-public@example.test',
    keywords: [],
    categories: [],
    agencies: [],
    audiences: ['public'],
    scope: 'all',
  });
  await confirmedSubscription({
    email: 'no-filter@example.test',
    keywords: [],
    categories: [],
    agencies: [],
    audiences: [],
    scope: 'all',
  });

  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      SITE_URL: 'https://zw.test',
      APP_BASE_URL: 'https://zw.test',
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      MAILER_OUTBOX_FILE: outboxFile,
      ATTACHMENT_TEXT: 'off',
    },
  });
});

after(async () => {
  await app?.stop();
});

describe('issue #84：订阅页上的受众面', () => {
  it('表单给出两档（公众广域 / 行业专业），并明说它是「并且」的收窄条件', async () => {
    const html = await (await fetch(`${app.url}/subscribe`)).text();
    assert.match(html, /data-testid="subscribe-audiences"/);
    assert.equal(
      (html.match(/data-testid="subscribe-audience-option"/g) ?? []).length,
      2,
      '只应有公众广域与行业专业两档',
    );
    assert.ok(html.includes('value="public"') && html.includes('value="sector"'));
    assert.ok(
      !html.includes('value="unknown"'),
      '「未判定」不能出现在订阅表单里：没人会说"把你们没归好类的发给我"，想全都收的人本来就不勾',
    );
    assert.match(html, /不勾 = 不限/);
    assert.match(html, /「并且」/, '必须说清它与关键词 / 领域 / 机关是 AND，不是"再多命中一档"');
  });

  it('真实 POST 带 audiences ⇒ 落库、确认邮件写明这是收窄条件', async () => {
    const response = await postSubscription({
      email: 'dana@example.test',
      scope: 'rules',
      audiences: 'public',
    });
    assert.equal(response.status, 303, '只勾受众面就该能提交（它是一条完整规则）');
    assert.match(response.headers.get('location') ?? '', /sent=1/);

    const confirmation = mailsTo('dana@example.test');
    assert.equal(confirmation.length, 1);
    assert.match(confirmation[0].text, /受众面（收窄条件，只有这些才会发）：公众广域/);

    // 落库结果直接查库核（未经确认的订阅不在 listActiveSubscriptions 里 —— 那正是
    // double opt-in 的现场，用它核对会得出"没落库"的错误结论）
    const db = new Database(dbFile, { readonly: true });
    let row;
    try {
      row = db
        .prepare('select audiences_json, confirmed from subscriptions where email = ?')
        .get('dana@example.test');
    } finally {
      db.close();
    }
    assert.ok(row, '提交必须建行（同邮箱重复提交则更新既有行）');
    assert.deepEqual(JSON.parse(row.audiences_json), ['public'], '受众面要真的写进那一列');
    assert.equal(row.confirmed, 0, '确认之前不得生效（double opt-in）');
  });

  it('两个都勾也接受，顺序去重后落库', async () => {
    const response = await postSubscription({
      email: 'erin@example.test',
      scope: 'rules',
      audiences: ['sector', 'public', 'sector'],
    });
    assert.equal(response.status, 303);
    const confirmation = mailsTo('erin@example.test');
    assert.equal(confirmation.length, 1);
    assert.match(
      confirmation[0].text,
      /受众面（收窄条件，只有这些才会发）：(公众广域、行业专业|行业专业、公众广域)/,
    );
    const db = new Database(dbFile, { readonly: true });
    let stored;
    try {
      stored = db
        .prepare('select audiences_json from subscriptions where email = ?')
        .get('erin@example.test');
    } finally {
      db.close();
    }
    assert.deepEqual(JSON.parse(stored.audiences_json), ['sector', 'public'], '去重且保序');
  });

  it('未知受众面被丢掉（不会悄悄变成"某一档"）⇒ 于是等于什么都没勾，被 no_rules 拒掉', async () => {
    const response = await postSubscription({
      email: 'frank@example.test',
      scope: 'rules',
      audiences: '林业',
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /error=no_rules/);
    assert.equal(mailsTo('frank@example.test').length, 0, '被拒的提交不该发任何邮件');

    // 关键的一半：**不能**静默放宽成"不限受众面"（那会让人以为自己订的是林业口径，
    // 实际收到全部）。白名单外的值必须等于没填，而不是等于没限制。
    const db = new Database(dbFile, { readonly: true });
    let count;
    try {
      count = db
        .prepare('select count(*) as c from subscriptions where email = ?')
        .get('frank@example.test').c;
    } finally {
      db.close();
    }
    assert.equal(count, 0, '被拒的提交不得留下任何行');
  });
});

describe('issue #84：提醒按受众面收窄', () => {
  before(async () => {
    logs = [];
    fs.rmSync(outboxFile, { force: true });
    await remindersJob.run(ctx);
  });

  it('条目侧的受众面确实按 audience.ts 判出来了（本文件其余断言的前提）', async () => {
    // 用订阅规则的匹配结果反查：不勾受众面的人两条都该收到。判据落在页面上不可见时，
    // 这条断言是"下面那些空收件箱不是因为分类没落库"的唯一证据。
    const mails = mailsTo('no-filter@example.test');
    assert.equal(mails.length, 1, '两条同时到档 ⇒ 合并成一封');
    assert.ok(mails[0].text.includes(PUBLIC_TITLE), '公众广域那条应在信里');
    assert.ok(mails[0].text.includes(SECTOR_TITLE), '行业专业那条应在信里');
    assert.match(mails[0].subject, /2 条公示即将截止/);
  });

  it('只勾「公众广域」⇒ 行业专业那条即使同轮到档也不发', async () => {
    const mails = mailsTo('public-only@example.test');
    assert.equal(mails.length, 1);
    assert.ok(mails[0].text.includes(PUBLIC_TITLE));
    assert.ok(
      !mails[0].text.includes(SECTOR_TITLE),
      `受众面是收窄条件，行业专业那条不该出现在「公众广域」订阅者的信里：${mails[0].text}`,
    );
    assert.equal(mails[0].subject.includes('2 条'), false, '只有一条到档时应走单条那封');
  });

  it('scope=all + 受众面 ⇒ 仍然只发那一档（"全部"不等于"绕过收窄"）', async () => {
    const mails = mailsTo('all-public@example.test');
    assert.equal(mails.length, 1);
    assert.ok(mails[0].text.includes(PUBLIC_TITLE));
    assert.ok(
      !mails[0].text.includes(SECTOR_TITLE),
      '把受众面判在 scope=all 短路之后，"只看公众广域"的人就会收到全部 —— 那是界面在撒谎',
    );
  });

  it('每条各自的去重标记都写了（合并成一封不等于少记一条）', async () => {
    logs = [];
    fs.rmSync(outboxFile, { force: true });
    await remindersJob.run(ctx);
    assert.match(logs.join('\n'), /截止提醒任务完成.*发送 0 封（共 0 条）/);
    assert.equal(readOutbox().length, 0, '重跑不得重发');
  });
});

describe('issue #84：管理入口把已勾的受众面回填出来', () => {
  it('带退订 token 打开订阅页 ⇒ 勾选状态回填，改完要再确认一次', async () => {
    const current = (await subsRepo.listActiveSubscriptions()).find((s) => s.email === 'public-only@example.test');
    assert.ok(current, '前置：该订阅应已确认');
    const html = await (await fetch(`${app.url}/subscribe?token=${current.unsubscribeToken}`)).text();
    assert.match(html, /data-testid="subscribe-manage-banner"/);
    // 属性顺序由 React 决定（实测 checked 在 value 之前），所以按标签整段判，
    // 不假设谁先谁后 —— 这条断言要表达的是"那一档被勾上了"，不是 DOM 的形状
    const publicTag = /<input[^>]*value="public"[^>]*>/.exec(html)?.[0] ?? '';
    assert.match(publicTag, /checked/, '已勾的那一档要回填（否则用户以为自己改丢了）');
    const sectorTag = /<input[^>]*value="sector"[^>]*>/.exec(html)?.[0] ?? '';
    assert.ok(sectorTag !== '' && !sectorTag.includes('checked'), '没勾的那一档不该也是勾上的');
  });
});

/**
 * 加一列要记得改三处（issue #83 F 项合并 `toNoticeRecord` 的同一个教训）：
 * 正式列、待确认列的序列化、以及**读侧的白名单**。这一组把后两处各钉一次。
 */
describe('issue #84：受众面在订阅确认流里的三处写入路径', () => {
  it('改受众面要走待确认：确认前生效的仍是旧的那一档', async () => {
    await confirmedSubscription({
      email: 'pending@example.test',
      keywords: [],
      categories: [],
      agencies: [],
      audiences: ['public'],
      scope: 'rules',
    });

    // 走**仓库层直调**而不是 HTTP：本条的判据是"新规则得完整落进待确认列"，
    // 而 HTTP 那条路上的写库是 .next 构建产物干的 —— 撤源码里的序列化它不会红
    // （pin「待确认规则漏写受众面」就靠这条断言成立）。HTTP 那条路在上面
    // dana / erin 两个用例里已经验过。
    const updated = await subsRepo.upsertSubscriptionRules({
      email: 'pending@example.test',
      keywords: [],
      categories: [],
      agencies: [],
      audiences: ['sector'],
      scope: 'rules',
      now: new Date(),
    });
    assert.equal(updated.outcome, 'confirmed-pending', '已确认订阅改规则必须再确认一次');

    const live = (await subsRepo.listActiveSubscriptions()).find((s) => s.email === 'pending@example.test');
    assert.deepEqual(live.audiences, ['public'], '确认前生效的必须还是旧规则');
    assert.deepEqual(
      live.pending?.audiences,
      ['sector'],
      '新规则要完整落进待确认列（漏了它 = 确认一次之后受众面悄悄消失）',
    );

    const confirmed = await subsRepo.confirmSubscriptionByToken(live.confirmToken);
    assert.equal(confirmed, 'confirmed');
    const applied = (await subsRepo.listActiveSubscriptions()).find((s) => s.email === 'pending@example.test');
    assert.deepEqual(applied.audiences, ['sector'], '确认这一刻才套用新规则');
    assert.equal(applied.pending, null, '套用完必须清空');
  });

  it('读侧：列里出现白名单外的值一律丢掉（放宽是可见方向，静默收死才最坏）', async () => {
    const db = new Database(dbFile);
    try {
      db.prepare(
        'update subscriptions set audiences_json = ? where email = ?',
      ).run('["public","林业","unknown"]', 'pending@example.test');
    } finally {
      db.close();
    }
    const dirty = (await subsRepo.listActiveSubscriptions()).find((s) => s.email === 'pending@example.test');
    assert.deepEqual(
      dirty.audiences,
      ['public'],
      '未知取值与"未判定"都不能进规则（它们不是可订档；保留下来会让这条订阅永远收不到信且毫无报错）',
    );
  });
});

/**
 * 合并之后最容易错的两件事：上限截断写错位置（把溢出的也标成"已通知"）
 * 与"合并 ≠ 减信息"。前者在 #60 的新公示通知上踩过同一个形状，这里对提醒再钉一次。
 */
describe('issue #84：合并提醒的条数上限（没列进的不写标记）', () => {
  const BATCH = 21;
  let firstRoundTitles = [];

  before(async () => {
    await confirmedSubscription({
      email: 'overflow@example.test',
      // 用关键词把这批圈进来：否则更早那两条也会到档，条数就与"21 条"对不上了
      keywords: ['批量行业标准'],
      categories: [],
      agencies: [],
      audiences: [],
      scope: 'rules',
    });
    for (let index = 0; index < BATCH; index += 1) {
      await seedNotice(`batch${String(index).padStart(11, '0')}`, `批量行业标准 ${index} 公开征求意见`);
    }
  });

  it('一轮最多列 20 条，溢出如实报数', async () => {
    logs = [];
    fs.rmSync(outboxFile, { force: true });
    await remindersJob.run(ctx);

    const mails = mailsTo('overflow@example.test');
    assert.equal(mails.length, 1, '21 条也只是**一封**');
    assert.match(mails[0].subject, /20 条公示即将截止/);
    assert.equal((mails[0].text.match(/^· /gm) ?? []).length, 20, '正文只列 20 条');
    assert.match(mails[0].text, /另有 1 条本轮未列入/);
    assert.match(logs.join('\n'), /溢出未列=1/);

    firstRoundTitles = [...mails[0].text.matchAll(/^· (.+)$/gm)].map((match) => match[1]);
  });

  it('没列进的那一条下一轮补上 —— 溢出部分确实没被标成"已通知"', async () => {
    logs = [];
    fs.rmSync(outboxFile, { force: true });
    await remindersJob.run(ctx);

    const mails = mailsTo('overflow@example.test');
    assert.equal(mails.length, 1, '剩下的那一条应单独成信（而不是永远看不到）');
    // 只剩一条 ⇒ 走单条那封（主题就是标题），**不是**"1 条公示即将截止"
    assert.ok(
      mails[0].subject.includes('批量行业标准'),
      `补发的那一条应是单条模板：${mails[0].subject}`,
    );
    assert.ok(!mails[0].subject.includes('20 条'), '不能再是一封列 20 条的信');
    const leftover = [...mails[0].text.matchAll(/^· (.+)$/gm)].map((match) => match[1]);
    // 只剩一条 ⇒ 走的是**单条模板**：没有项目符号行，标题在第一行
    assert.equal(leftover.length, 0, `单条模板不该有项目符号行：${mails[0].text}`);
    const leftoverTitle = /你订阅的公示「(.+?)」即将截止/.exec(mails[0].text)?.[1];
    assert.ok(leftoverTitle, `单条模板应在首行给出标题：${mails[0].text}`);
    assert.ok(
      !firstRoundTitles.includes(leftoverTitle),
      `补发的那条必须是上一封没列进去的那一条，实际重复了：${leftoverTitle}`,
    );
    assert.match(leftoverTitle, /^批量行业标准 \d+ 公开征求意见$/);
  });
});
