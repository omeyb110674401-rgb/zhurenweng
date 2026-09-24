import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
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
