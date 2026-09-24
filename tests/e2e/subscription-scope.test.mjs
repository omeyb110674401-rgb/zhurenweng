import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { startAppServer } from './helpers/app-server.mjs';

/**
 * 端到端（issue #60 第 2 刀）：按发布机关订阅 + 「订全部新公示」。
 *
 * 覆盖的是这条链上最容易各写一份口径的四段：**表单 → 提交端点 → 落库回读 → 提醒匹配**。
 * 任何一段漏掉新字段，表现都是「用户勾了机关却收不到」—— 不报错、无日志、
 * 只能等一个真人来投诉。所以这里既走真实的 HTTP 提交（构建产物里的路由），
 * 也走真实的提醒任务（stub 邮件端口把信写进 outbox 文件），两头都验。
 *
 * 零外部依赖（ADR-0001）：临时 SQLite + stub LLM / 邮件，不起数据库、不出网。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-sub-scope-'));
const dbFile = path.join(workDir, 'app.db');
const outboxFile = path.join(workDir, 'outbox.jsonl');

const JOINT_TITLE = '关于联合发文某办法公开征求意见的公告';
const OTHER_TITLE = '关于单独发文某标准公开征求意见的公告';

const jointId = 'c'.repeat(32);
const otherId = 'd'.repeat(32);

let app;
let noticesRepo;
let subsRepo;
let remindersJob;
let logs;

const ctx = { logger: (message) => logs.push(message), now: () => new Date() };

/** 距今 N 天的 ISO 日期（截止提醒按东八区日历算，这里只保证"整七天"）。 */
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

/** 建一条已确认订阅（跳过邮件确认，直接走 token 确认那对函数）。 */
async function confirmedSubscription(input) {
  const created = await subsRepo.upsertSubscriptionRules({ ...input, now: new Date() });
  const confirmed = await subsRepo.confirmSubscriptionByToken(created.subscription.confirmToken);
  assert.equal(confirmed, 'confirmed', `订阅 ${input.email} 应能确认成功`);
  return created.subscription;
}

before(async () => {
  process.env.DB_DRIVER = 'sqlite';
  process.env.DATABASE_URL = dbFile;
  process.env.LLM_PROVIDER = 'stub';
  process.env.MAILER_PROVIDER = 'stub';
  process.env.MAILER_OUTBOX_FILE = outboxFile;
  process.env.SITE_URL = 'https://zw.test';
  process.env.APP_BASE_URL = 'https://zw.test';
  // 附件抽取不参与本场景（夹具没附件），关掉以免多跑一段无关逻辑
  process.env.ATTACHMENT_TEXT = 'off';

  // 客户端单例：env 就位之前不能 import
  noticesRepo = await import('../../src/db/repo/notices.ts');
  subsRepo = await import('../../src/db/repo/subscriptions.ts');
  const sourcesRepo = await import('../../src/db/repo/sources.ts');
  remindersJob = (await import('../../worker/jobs/send-deadline-reminders.ts')).sendDeadlineRemindersJob;

  await sourcesRepo.registerSource({ id: 'e2e-sub-scope', name: '订阅范围测试源', adapterType: 'fixture' });
  const seed = async (id, title, agency) => {
    await noticesRepo.upsertNotice({
      id,
      sourceId: 'e2e-sub-scope',
      title,
      agency,
      url: `https://source.test/${id}.html`,
      publishedAt: datePlusDays(-1),
      deadlineAt: datePlusDays(7),
      status: 'open',
      bodyText: '现向社会公开征求意见，请于截止日期前反馈。',
      attachments: [],
      fetchedAt: new Date().toISOString(),
    });
  };
  // 一条联合发文（两个参与机关）、一条无关机关 —— 用来验「按参与机关算」
  await seed(jointId, JOINT_TITLE, '司法部、中国民用航空局');
  await seed(otherId, OTHER_TITLE, '生态环境部');

  await confirmedSubscription({
    email: 'joint@example.test',
    keywords: [],
    categories: [],
    agencies: ['中国民用航空局'],
    scope: 'rules',
  });
  await confirmedSubscription({
    email: 'everything@example.test',
    keywords: [],
    categories: [],
    agencies: [],
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

describe('issue #60 第 2 刀：按机关订阅与「订全部新公示」', () => {
  it('订阅页给出范围单选与库内实际出现过的机关候选', async () => {
    const html = await (await fetch(`${app.url}/subscribe`)).text();
    assert.match(html, /data-testid="subscribe-scope-rules"/, '范围应有「按条件」');
    assert.match(html, /data-testid="subscribe-scope-all"/, '范围应有「订全部」');
    assert.ok(
      html.includes('选这项时下面三项不再生效'),
      '「订全部」必须明说它会让条件失效 —— 否则用户以为关键词还在起作用',
    );
    // 候选来自库里实际出现过的机关（含联合发文拆出来的参与机关），不是写死的清单
    assert.match(html, /data-testid="subscribe-agencies"/);
    for (const agency of ['司法部', '中国民用航空局', '生态环境部']) {
      assert.ok(html.includes(agency), `机关候选应含「${agency}」（它就在库里）`);
    }
  });

  it('真实 POST 带 agencies ⇒ 提交端点解析、落库、确认邮件写明机关', async () => {
    const response = await fetch(`${app.url}/api/subscriptions`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        email: 'carol@example.test',
        scope: 'rules',
        agencies: '司法部',
      }).toString(),
    });
    assert.equal(response.status, 303, '提交成功应 303 回订阅页');
    assert.match(response.headers.get('location') ?? '', /sent=1/);

    const confirmations = mailsTo('carol@example.test');
    assert.equal(confirmations.length, 1, '应发出一封确认邮件');
    assert.match(
      confirmations[0].text,
      /发布机关：司法部/,
      '确认邮件要写明订阅到的机关 —— 用户确认的是这份规则，不是猜',
    );
    assert.ok(
      !confirmations[0].text.includes('不限关键词'),
      'scope=rules 时不能出现「订全部」的说法',
    );
  });

  it('只填范围=all 而不给任何条件也允许提交（邮件里写明不限条件）', async () => {
    const response = await fetch(`${app.url}/api/subscriptions`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'all@example.test', scope: 'all' }).toString(),
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /sent=1/);
    assert.match(mailsTo('all@example.test')[0].text, /收录的全部新公示|不限关键词/);
  });

  it('范围与条件都为空 ⇒ 拒绝，且不当成「订全部」（空规则是漏填，不是要全部）', async () => {
    const response = await fetch(`${app.url}/api/subscriptions`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'nobody@example.test' }).toString(),
    });
    assert.equal(response.status, 303);
    assert.match(
      response.headers.get('location') ?? '',
      /error=no_rules/,
      '空条件必须被拒 —— 静默当成"订全部"会让用户在收了一堆邮件后才发现自己没设条件',
    );
    assert.equal(mailsTo('nobody@example.test').length, 0, '被拒的提交不该发任何邮件');
  });

  it('提醒按参与机关命中：订「中国民用航空局」只收到联合发文那条，订全部的收到两条', async () => {
    logs = [];
    fs.rmSync(outboxFile, { force: true });
    await remindersJob.run(ctx);

    const joint = mailsTo('joint@example.test');
    assert.equal(joint.length, 1, '只应收到它那一条');
    assert.ok(joint[0].subject.includes(JOINT_TITLE), '联合发文的每个参与机关都应能单独命中');
    assert.ok(!joint[0].subject.includes(OTHER_TITLE), '无关机关的条目不该发来');

    const everything = mailsTo('everything@example.test');
    assert.equal(everything.length, 2, '订全部 ⇒ 每条新公示的提醒都该收到');
    assert.ok(!logs.join('\n').includes('无已确认订阅'));
  });
});

/**
 * 新公示通知（issue #60 第 3 刀）。
 *
 * 与截止提醒的关键差别在**判据不是"还剩几天"而是"这条什么时候第一次进库"**，
 * 而 `fetched_at` 每天被 upsert 覆盖，用它当判据会把老条目天天重发 —— 所以这里
 * 专门验一次：把 `first_seen_at` 置 NULL（等价于本次上线之前就存在的存量条目）之后，
 * 谁都不该收到它。这条断言是"刚确认订阅的老邮箱不会被历史条目轰炸"的唯一防线。
 */
describe('issue #60 第 3 刀：新公示通知（一人一封汇总、条目×订阅去重）', () => {
  let notifyJob;

  function mutate(sql, ...params) {
    const db = new Database(dbFile);
    try {
      db.prepare(sql).run(...params);
    } finally {
      db.close();
    }
  }

  before(async () => {
    notifyJob = (await import('../../worker/jobs/notify-new-notices.ts')).notifyNewNoticesJob;
  });

  async function runNotify() {
    logs = [];
    fs.rmSync(outboxFile, { force: true });
    await notifyJob.run(ctx);
    return logs.join('\n');
  }

  const isNoticeMail = (mail) => mail.subject.includes('新公示');

  it('命中规则的订阅者各收到一封汇总（不是一条一封），未确认的一封都不收', async () => {
    const output = await runNotify();
    assert.match(output, /新公示通知任务完成[^\n]*发送 \d+ 封/);

    const everything = mailsTo('everything@example.test').filter(isNoticeMail);
    assert.equal(everything.length, 1, '两条新公示应是**一封**两条目，而不是两封信');
    assert.match(everything[0].text, /根据你订阅的条件，本站有新的公示收录/);
    assert.ok(
      everything[0].text.includes(JOINT_TITLE) && everything[0].text.includes(OTHER_TITLE),
      '两条都要列出来',
    );
    assert.ok(everything[0].text.includes('unsubscribe?token='), '每封邮件都要能一键退订');
    assert.ok(
      !/AI 摘要/.test(everything[0].text),
      '新公示的摘要可能还没生成，邮件里不能承诺"含 AI 摘要"',
    );

    const joint = mailsTo('joint@example.test').filter(isNoticeMail);
    assert.equal(joint.length, 1);
    assert.ok(joint[0].text.includes(JOINT_TITLE), '按机关订阅命中联合发文里的参与机关');
    assert.ok(!joint[0].text.includes(OTHER_TITLE), '不命中规则的不进这封信');

    // carol 只提交未确认：绝不该收到任何东西
    assert.equal(mailsTo('carol@example.test').filter(isNoticeMail).length, 0);
    assert.equal(mailsTo('nobody@example.test').length, 0, '被拒的提交不该收到任何邮件');
  });

  it('重复运行不发第二封（条目 × 订阅去重）', async () => {
    await runNotify();
    const output = await runNotify();
    assert.match(output, /发送 0 封/);
    assert.equal(readOutbox().filter(isNoticeMail).length, 0, '去重表已写过 ⇒ 本轮不该再发');
  });

  it('first_seen_at 为空 = 上线之前就存在的存量条目，永不通知', async () => {
    mutate('update notices set first_seen_at = null');
    const output = await runNotify();
    assert.match(output, /回看 \d+ 天内无新收录条目，跳过新公示通知/);
    assert.equal(readOutbox().filter(isNoticeMail).length, 0);

    // 只把其中一条标成"新"，并清掉去重标记（否则它已被前面几轮通知过 —— 那才是正确行为，
    // 不是本条要验的东西）：那一条要能被通知到，证明判据确实是 first_seen_at 这一列
    mutate('delete from notice_notifications');
    mutate('update notices set first_seen_at = ? where id = ?', new Date().toISOString(), jointId);
    const again = await runNotify();
    assert.match(again, /新公示通知任务完成[^\n]*发送 2 封/);
    assert.equal(mailsTo('joint@example.test').filter(isNoticeMail).length, 1);
    assert.ok(!mailsTo('everything@example.test').filter(isNoticeMail)[0].text.includes(OTHER_TITLE));
  });

  it('超出每封上限时只列一部分，没列进的**不写去重标记**（否则用户永远看不到它们）', async () => {    const nowIso = new Date().toISOString();
    const extraIds = Array.from({ length: 21 }, (_v, i) => `${'e'.repeat(30)}${String(i).padStart(2, '0')}`);
    for (const [index, id] of extraIds.entries()) {
      mutate(
        `insert into notices (id, source_id, title, agency, url, published_at, deadline_at, status,
           category_tags_json, body_text, attachments_json, summary_status, fetched_at, outbound_clicks, first_seen_at)
         values ('${id}', 'e2e-sub-scope', '批量新公示 ${index}', '生态环境部', 'https://source.test/batch-${index}.html',
           date('now'), date('now','+20 day'), 'open', '[]', '正文', '[]', 'pending', '${nowIso}', 0, '${nowIso}')`,
      );
    }
    const output = await runNotify();
    const mail = mailsTo('everything@example.test').find(isNoticeMail);
    assert.ok(mail, '订全部的人应收到这一封');
    assert.match(mail.subject, /新公示 20 条/, '主题按实际列出的条数说，不是命中总数');
    assert.equal((mail.text.match(/^· /gm) ?? []).length, 20, '正文只列 20 条');
    assert.match(mail.text, /另有 1 条本次未列入/, '溢出的条数要如实说出来');
    assert.match(output, /溢出未列=1/);

    // 下一封必须只含没列进的那一条 —— 证明溢出部分没被误标成"已通知"
    const secondOutput = await runNotify();
    assert.match(secondOutput, /新公示通知任务完成[^\n]*发送 1 封/);
    const second = mailsTo('everything@example.test').filter(isNoticeMail).at(-1);
    assert.ok(second, '溢出那条应在下一封里发出');
    assert.match(second.subject, /新公示 1 条|新公示：批量新公示 20/);
  });

  it('一封都没发出去时不能留下"已通知"的痕迹（下一轮还得再来一遍）', async () => {
    mutate('delete from notice_notifications');
    process.env.MAILER_STUB_FAILURES = 'always';
    try {
      const output = await runNotify();
      assert.match(output, /新公示通知发送失败/);
      assert.match(output, /发送 0 封/);
      assert.equal(readOutbox().filter(isNoticeMail).length, 0);
    } finally {
      delete process.env.MAILER_STUB_FAILURES;
    }
    const db = new Database(dbFile, { readonly: true });
    let marked = 0;
    try {
      marked = db.prepare('select count(*) as c from notice_notifications').get().c;
    } finally {
      db.close();
    }
    assert.equal(marked, 0, '发信失败却写了去重标记 ⇒ 这批条目永远不会再通知任何人');

    const retried = await runNotify();
    assert.match(retried, /新公示通知任务完成[^\n]*发送 [1-9]\d* 封/, '下一轮应把这批条目补上');
  });
});
