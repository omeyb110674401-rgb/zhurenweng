import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { startAppServer } from './helpers/app-server.mjs';
import { createFixtureServer } from './helpers/fixture-server.mjs';

/**
 * E2E（issue #7）：邮件订阅与截止提醒全链路。
 *
 * fixture 快照（fixtures/e2e-reminders/，先拷贝到临时目录再服务，测试中后段
 * 会向库内补插合成条目）经日期令牌把条目截止日期固定在「今天 + 7 天 / + 3 天」
 *   → 真实 worker 进程抓取入库（WORKER_ONCE=1，SOURCES_FIXTURE_BASE 注入 fixture 源站）
 *   → /subscribe 表单提交（校验 / 重复邮箱更新规则 / 确认邮件经 MAILER_OUTBOX_FILE 捕获）
 *   → double opt-in：未确认时触发提醒任务 → 无邮件；点击确认链接 → 订阅生效
 *   → 再触发提醒任务 → +7 一封、+3 一封，内容含标题 / 剩余天数 / 截止日期 /
 *     站内详情链接 / 官方原文链接；关键词命中标题或正文、领域命中标签均可触发
 *   → 重跑任务不重发（reminder_sends 去重）
 *   → 匹配规则外的条目不发
 *   → 一键退订立即生效，退订后新条目也不再发送
 *
 * 全程零外部依赖（ADR-0001）：SQLite 临时文件库 + 本地 fixture 源站 + stub 邮件
 * （JSONL outbox 跨进程断言）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceFixturesDir = path.join(repoRoot, 'fixtures', 'e2e-reminders');
const workDir = mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue7-'));
const fixturesDir = path.join(workDir, 'fixtures');
const dbFile = path.join(workDir, 'app.db');
const outboxFile = path.join(workDir, 'outbox.jsonl');

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

const TITLES = {
  noiseD7: '中华人民共和国噪声污染防治法（修订草案）征求意见',
  idCardD3: '中华人民共和国公民身份证法（修正草案）征求意见',
  fisheryD7: '中华人民共和国渔业法（修订草案）征求意见',
};

// 测试中后段经仓库层补插的合成条目（抓取管线暂不产出领域标签，且需要
// 「确认 / 退订之后才出现」的新条目来验证时机，故从数据缝注入）
const EXTRA = {
  categoryD7: {
    id: 'e2e-rem-category-d7',
    title: '中华人民共和国自然保护区条例（修订草案）征求意见',
    url: 'https://fixture.invalid/e2e-reminders/category-d7',
    categoryTags: ['生态环境'],
    offsetDays: 7,
  },
  keywordD3: {
    id: 'e2e-rem-keyword-d3',
    title: '中华人民共和国噪声污染防治法实施条例（征求意见稿）征求意见',
    url: 'https://fixture.invalid/e2e-reminders/keyword-d3',
    categoryTags: [],
    offsetDays: 3,
  },
};

let app;
let fixtures;
let fixtureUrl;

/** 与抓取管线一致的条目主键：原文 URL 的 SHA-256 前缀。 */
function noticeIdFor(url) {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

/** 本地日历日 + N 天的 ISO 日期（YYYY-MM-DD）。 */
function isoDatePlusDays(offsetDays) {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 单轮运行真实 worker 子进程，返回 { code, output }。 */
function runWorkerOnce() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['worker/index.ts'], {
      cwd: repoRoot,
      env: { ...process.env, WORKER_ONCE: '1' },
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

/** 读取 stub 邮件 outbox（JSONL），返回邮件对象数组。 */
function readOutbox() {
  if (!existsSync(outboxFile)) return [];
  return readFileSync(outboxFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function mailsTo(email) {
  return readOutbox().filter((mail) => mail.to === email);
}

/** 按「收件人 + 主题含片段」筛邮件并断言唯一。 */
function assertOneMail(email, subjectPart) {
  const mails = mailsTo(email).filter((mail) => mail.subject.includes(subjectPart));
  assert.equal(
    mails.length,
    1,
    `${email} 应恰好收到 1 封主题含「${subjectPart}」的邮件，实际 ${mails.length} 封：${JSON.stringify(mails.map((m) => m.subject))}`,
  );
  return mails[0];
}

/** 提交订阅表单（form-urlencoded POST），返回 303 响应。 */
function postSubscription({ email, keywords = '', categories = [] }) {
  const body = new URLSearchParams({ email, keywords });
  for (const category of categories) body.append('categories', category);
  return fetch(`${app.url}/api/subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
  });
}

/** 从邮件文本中提取站内链接（确认 / 退订）。 */
function extractLink(text, pathPrefix) {
  const matches = [...text.matchAll(new RegExp(`https?://\\S+${pathPrefix}\\?token=[A-Za-z0-9_-]+`, 'g'))];
  assert.ok(matches.length > 0, `邮件文本应含 ${pathPrefix} 链接：${text}`);
  return matches[0][0];
}

/** GET 一个带 303 的链接并跟随重定向，返回最终响应。 */
async function followGet(url) {
  const response = await fetch(url, { redirect: 'follow' });
  return { response, html: await response.text() };
}

/** 从 fixture 源站取已替换日期令牌的截止日期，归一化为 ISO（YYYY-MM-DD）。 */
async function servedDeadline(detailPath) {
  const response = await fetch(`${fixtureUrl}${detailPath}`);
  const html = await response.text();
  const iso = /征求意见截止日期：(\d{4}-\d{1,2}-\d{1,2})/.exec(html);
  const cn = /征求意见截止日期：(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(html);
  assert.ok(iso || cn, `fixture 详情页应含已替换的截止日期：${detailPath}`);
  if (iso) return iso[1];
  const [, y, m, d] = cn;
  return `${y}-${String(Number(m)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`;
}

before(async () => {
  // fixture 目录拷贝到临时目录：本场景不修改仓库内快照，仍可按需改写副本
  cpSync(sourceFixturesDir, fixturesDir, { recursive: true });
  fixtures = createFixtureServer({ fixturesDir });
  fixtureUrl = (await fixtures.start()).url;

  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      MAILER_OUTBOX_FILE: outboxFile,
      // 关键注入：源适配器列表页指向本地 fixture 源站；邮件链接指向本应用
      SOURCES_FIXTURE_BASE: fixtureUrl,
    },
  });
  // APP_BASE_URL 在服务器启动后注入（进程内环境变量，worker 子进程同样继承）
  process.env.APP_BASE_URL = app.url;
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
  // 不清理 workDir：Windows 上已打开的 SQLite 句柄会令 rmSync EPERM，
  // 临时目录交由操作系统回收（与既有场景一致）。
});

describe('issue #7：订阅 double opt-in → 截止提醒 → 一键退订', () => {
  it('订阅页可访问，表单与领域选项齐备', async () => {
    const response = await fetch(`${app.url}/subscribe`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /订阅截止提醒/);
    assert.match(html, /action="\/api\/subscriptions"/);
    assert.match(html, /生态环境/, '领域选项应含生态环境');
  });

  it('输入校验：非法邮箱被拒且不发送任何邮件', async () => {
    const response = await postSubscription({ email: 'not-an-email', keywords: '噪声污染防治' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/subscribe?error=invalid_email');

    const { html } = await followGet(`${app.url}/subscribe?error=invalid_email`);
    assert.match(html, /邮箱格式不正确/);
    assert.equal(readOutbox().length, 0);
  });

  it('输入校验：无任何规则被拒且不发送任何邮件', async () => {
    const response = await postSubscription({ email: ALICE, keywords: '' });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location'), /error=no_rules/);
    const { html } = await followGet(`${app.url}/subscribe?error=no_rules`);
    assert.match(html, /请至少填写一个关键词或选择一个领域/);
    assert.equal(readOutbox().length, 0);
  });

  it('抓取入库后无任何订阅，提醒任务空转不发信', async () => {
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /源 npc 抓取完成：列表 3 条，新增 3，更新 0/);
    assert.match(run.output, /无已确认订阅，截止提醒任务跳过/);
    assert.equal(readOutbox().length, 0);
  });

  it('alice 提交订阅：创建待确认订阅并发确认邮件（含确认与退订链接）', async () => {
    const response = await postSubscription({ email: ALICE, keywords: '噪声污染防治' });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location'), /sent=1/);
    const { html } = await followGet(`${app.url}/subscribe?sent=1`);
    assert.match(html, /确认邮件已发送/);
    assert.match(html, /确认前订阅不生效/);

    const mails = mailsTo(ALICE);
    assert.equal(mails.length, 1, `应发出 1 封确认邮件，实际 ${JSON.stringify(mails)}`);
    assert.match(mails[0].subject, /请确认你的公示提醒订阅/);
    assert.match(mails[0].text, /关键词：噪声污染防治/);
    assert.match(mails[0].text, /subscribe\/confirm\?token=/);
    assert.match(mails[0].text, /unsubscribe\?token=/, '确认邮件底部应含一键退订链接');
    assert.ok(extractLink(mails[0].text, '/subscribe/confirm').startsWith(app.url));
  });

  it('alice 重复提交（同邮箱）：更新规则不重复建行，重发确认邮件且旧链接失效', async () => {
    const before = await postSubscription({
      email: ALICE,
      keywords: '噪声污染防治，医疗保障',
      categories: ['生态环境'],
    });
    assert.equal(before.status, 303);
    assert.match(before.headers.get('location'), /sent=1/);

    // outbox 累计 2 封 alice 确认邮件；数据库仍是单行（后续提醒每条目只发 1 封可证）
    const mails = mailsTo(ALICE);
    assert.equal(mails.length, 2);

    const oldLink = extractLink(mails[0].text, '/subscribe/confirm');
    const newLink = extractLink(mails[1].text, '/subscribe/confirm');
    assert.notEqual(oldLink, newLink, '重新提交应轮换确认 token');
    assert.match(mails[1].text, /噪声污染防治、医疗保障/, '规则应更新为 v2');
    assert.match(mails[1].text, /领域：生态环境/, '规则应更新为 v2（领域）');

    const oldResult = await followGet(oldLink);
    assert.match(oldResult.response.url, /state=invalid/);
    assert.match(oldResult.html, /确认链接无效/);
  });

  it('bob 提交订阅并收到确认邮件', async () => {
    const response = await postSubscription({ email: BOB, keywords: '噪声污染防治' });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location'), /sent=1/);
    assert.equal(mailsTo(BOB).length, 1);
  });

  it('double opt-in：未确认时触发提醒任务，任何人都不收到提醒', async () => {
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    // 订阅均为待确认状态 → 收件人为空
    assert.match(run.output, /无已确认订阅，截止提醒任务跳过/);
    assert.equal(readOutbox().length, 3, 'outbox 应只有 3 封确认邮件，无任何提醒');
  });

  it('点击确认链接后订阅生效（alice 新链接成功，旧链接已失效）', async () => {
    const aliceLink = extractLink(mailsTo(ALICE)[1].text, '/subscribe/confirm');
    const aliceResult = await followGet(aliceLink);
    assert.match(aliceResult.response.url, /\/subscribe\/confirmed$/);
    assert.match(aliceResult.html, /订阅已确认/);
    assert.match(aliceResult.html, /截止前 7 天、3 天各发送一封提醒邮件/);

    const bobLink = extractLink(mailsTo(BOB)[0].text, '/subscribe/confirm');
    const bobResult = await followGet(bobLink);
    assert.match(bobResult.response.url, /\/subscribe\/confirmed$/);
    assert.match(bobResult.html, /订阅已确认/);
  });

  it('提醒触发时机与内容：+7 一封、+3 一封；关键词命中标题 / 正文均触发', async () => {
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /截止提醒任务完成：候选条目 3，订阅 2，发送 3 封/);

    const deadlineD7 = await servedDeadline('/npc/c2/c30834/t20260910_210001.html');
    const deadlineD3 = await servedDeadline('/npc/c2/c30834/t20260910_210002.html');
    const noiseId = noticeIdFor(`${fixtureUrl}/npc/c2/c30834/t20260910_210001.html`);
    const idCardId = noticeIdFor(`${fixtureUrl}/npc/c2/c30834/t20260910_210002.html`);

    // alice：+7（标题命中）+ +3（正文命中「医疗保障」）
    const aliceD7 = assertOneMail(ALICE, TITLES.noiseD7);
    assert.match(aliceD7.subject, /剩 7 天/);
    assert.match(aliceD7.text, new RegExp(`截止日期：${deadlineD7}（还剩 7 天`));
    assert.ok(
      aliceD7.text.includes(`${app.url}/notices/${noiseId}`),
      `提醒应含站内详情链接 ${app.url}/notices/${noiseId}：${aliceD7.text}`,
    );
    assert.ok(
      aliceD7.text.includes(`${fixtureUrl}/npc/c2/c30834/t20260910_210001.html`),
      '提醒应含官方原文（提意）链接',
    );
    assert.match(aliceD7.text, /unsubscribe\?token=/);

    const aliceD3 = assertOneMail(ALICE, TITLES.idCardD3);
    assert.match(aliceD3.subject, /剩 3 天/);
    assert.match(aliceD3.text, new RegExp(`截止日期：${deadlineD3}（还剩 3 天`));
    assert.ok(aliceD3.text.includes(`${app.url}/notices/${idCardId}`));
    assert.ok(
      aliceD3.text.includes(`${fixtureUrl}/npc/c2/c30834/t20260910_210002.html`),
      '官方原文链接应指向该条目的详情快照',
    );

    // bob：仅 +7 一封（其规则不含「医疗保障」，正文命中的条目不触发）
    const bobD7 = assertOneMail(BOB, TITLES.noiseD7);
    assert.match(bobD7.subject, /剩 7 天/);
    assert.equal(
      mailsTo(BOB).filter((mail) => mail.subject.includes(TITLES.idCardD3)).length,
      0,
      'bob 不应收到规则外条目的提醒',
    );

    // 每位订阅者每条目只 1 封（同邮箱单行，未重复建行）
    for (const email of [ALICE, BOB]) {
      const noiseMails = mailsTo(email).filter((mail) => mail.subject.includes(TITLES.noiseD7));
      assert.equal(noiseMails.length, 1, `${email} 对同一条目只应收到 1 封提醒`);
    }

    // 匹配规则外的条目（渔业法，+7 但无人命中）不发送
    const fisheryMails = readOutbox().filter((mail) => mail.subject.includes(TITLES.fisheryD7));
    assert.equal(fisheryMails.length, 0);
  });

  it('重复运行提醒任务：不重发任何邮件（条目×档×订阅去重）', async () => {
    const before = readOutbox().length;
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /发送 0 封，去重跳过 3 次/);
    assert.equal(readOutbox().length, before, '重复运行不得产生新邮件');
  });

  it('领域匹配：领域标签命中的条目触发提醒（关键词不命中的订阅者不受影响）', async () => {
    const { upsertNotice } = await import('../../src/db/repo/notices.ts');
    await upsertNotice({
      id: EXTRA.categoryD7.id,
      sourceId: 'npc',
      title: EXTRA.categoryD7.title,
      agency: '全国人大常委会法制工作委员会',
      url: EXTRA.categoryD7.url,
      publishedAt: '2026-09-10',
      deadlineAt: isoDatePlusDays(EXTRA.categoryD7.offsetDays),
      status: 'open',
      categoryTags: EXTRA.categoryD7.categoryTags,
      bodyText: '自然保护区的设立与管理……（无订阅关键词）',
      attachments: [],
      fetchedAt: new Date().toISOString(),
    });

    const before = readOutbox().length;
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /发送 1 封/);
    assert.equal(readOutbox().length, before + 1);

    const aliceMail = assertOneMail(ALICE, EXTRA.categoryD7.title);
    assert.match(aliceMail.subject, /剩 7 天/);
    assert.ok(
      aliceMail.text.includes(EXTRA.categoryD7.url),
      '提醒应含官方原文（提意）链接',
    );
    assert.ok(
      aliceMail.text.includes(`${app.url}/notices/${EXTRA.categoryD7.id}`),
      '提醒应含站内详情链接',
    );
    // bob 的规则（仅关键词）不命中该条目
    assert.equal(
      mailsTo(BOB).filter((mail) => mail.subject.includes(EXTRA.categoryD7.title)).length,
      0,
      'bob 不应收到领域命中的提醒（其订阅无领域规则）',
    );
  });

  it('再次重复运行仍不重发', async () => {
    const before = readOutbox().length;
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /发送 0 封/);
    assert.equal(readOutbox().length, before);
  });

  it('一键退订立即生效；无效退订链接展示失败态', async () => {
    const aliceMail = assertOneMail(ALICE, TITLES.noiseD7);
    const unsubscribeLink = extractLink(aliceMail.text, '/unsubscribe');

    const result = await followGet(unsubscribeLink);
    assert.match(result.response.url, /\/unsubscribe\/done\?ok=1/);
    assert.match(result.html, /已退订/);
    assert.match(result.html, /退订已立即生效/);

    const invalid = await followGet(`${app.url}/unsubscribe?token=bogus-token`);
    assert.match(invalid.response.url, /ok=0/);
    assert.match(invalid.html, /退订链接无效/);
  });

  it('退订后新条目不再发送：关键词命中的新提醒只发给未退订的订阅者', async () => {
    const { upsertNotice } = await import('../../src/db/repo/notices.ts');
    await upsertNotice({
      id: EXTRA.keywordD3.id,
      sourceId: 'npc',
      title: EXTRA.keywordD3.title,
      agency: '全国人大常委会法制工作委员会',
      url: EXTRA.keywordD3.url,
      publishedAt: '2026-09-12',
      deadlineAt: isoDatePlusDays(EXTRA.keywordD3.offsetDays),
      status: 'open',
      categoryTags: EXTRA.keywordD3.categoryTags,
      bodyText: '噪声污染防治的监督管理……',
      attachments: [],
      fetchedAt: new Date().toISOString(),
    });

    const before = readOutbox().length;
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /发送 1 封/);
    assert.equal(readOutbox().length, before + 1);

    // bob（未退订，关键词命中标题）收到新条目提醒
    const bobMail = assertOneMail(BOB, EXTRA.keywordD3.title);
    assert.match(bobMail.subject, /剩 3 天/);
    assert.ok(bobMail.text.includes(EXTRA.keywordD3.url));

    // alice 已退订：其规则同样命中该条目，但不再收到任何邮件
    const aliceMailsAfter = mailsTo(ALICE).filter((mail) =>
      mail.subject.includes(EXTRA.keywordD3.title),
    );
    assert.equal(aliceMailsAfter.length, 0, '退订后不得再收到任何提醒');
    assert.equal(
      mailsTo(ALICE).length,
      5,
      'alice 的邮件总数应停在退订前（2 封确认 + 3 封提醒），不再新增',
    );
  });
});
