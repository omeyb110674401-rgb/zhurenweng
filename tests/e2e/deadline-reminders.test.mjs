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

/**
 * 只看截止提醒邮件（issue #60 第 3 刀之后必须区分）。
 *
 * worker 一轮里现在有两个发信任务（截止提醒 + 新公示通知），它们写同一个 outbox。
 * 不按主题分流的话，「重复运行不重发」这类计数断言会把新公示通知当成提醒的重发 ——
 * 那是把正确的行为测成失败。分流条件用主题前缀，比按条数硬编码稳。
 */
const isReminderMail = (mail) => mail.subject.includes('截止提醒');
const reminderOutbox = () => readOutbox().filter(isReminderMail);
const reminderMailsTo = (email) => reminderOutbox().filter((mail) => mail.to === email);

/** 按「收件人 + 主题含片段」筛邮件并断言唯一。 */
function assertOneMail(email, subjectPart) {
  const mails = reminderOutbox()
    .filter((mail) => mail.to === email)
    .filter((mail) => mail.subject.includes(subjectPart));
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

/**
 * 点确认页上的「确认订阅」按钮（POST 动作端点，issue #52），跟随 303 到结果页。
 * 与 postSubscription 分开：一个是提交订阅，一个是确认订阅，语义不同。
 */
async function postConfirm(token) {
  const response = await fetch(`${app.url}/subscribe/confirm/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
    redirect: 'follow',
  });
  return { response, html: await response.text() };
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

/**
 * 官方原文（人工可读页面）URL：由列表接口的 flxxId 拼出条目页地址
 * （本源列表与正文都是接口数据，但入库唯一键与用户可见链接是人工页）。
 */
function officialUrlOf(lid) {
  return `${fixtureUrl}/npc/userIndex.html?lid=${lid}`;
}

/** 从 fixture 源站取已替换日期令牌的详情接口 JSON，读出截止日期（ISO，YYYY-MM-DD）。 */
async function servedDeadline(lid) {
  const response = await fetch(`${fixtureUrl}/npc/flca/${lid}/info/`);
  assert.equal(response.status, 200, `fixture 应提供详情接口快照：${lid}`);
  const payload = await response.json();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(payload.jsrq ?? ''));
  assert.ok(iso, `fixture 详情接口应含已替换的截止日期（jsrq）：${lid}`);
  const [, y, m, d] = iso;
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
    assert.match(html, /订阅公示提醒/);
    assert.match(html, /action="\/api\/subscriptions"/);
    assert.match(html, /生态环境/, '领域选项应含生态环境');
    assert.ok(!html.includes('subscribe-unavailable-banner'), 'stub 邮件端口可用 → 不显示不可用提示');
  });

  it('邮件端口可用时首页出现订阅入口（issue #17 门控的正向分支）', async () => {
    const home = await (await fetch(`${app.url}/`)).text();
    assert.match(home, /data-testid="subscribe-nav-link"/, '导航应有订阅提醒入口');
    assert.match(home, /data-testid="subscribe-list-link"/, '列表头（RSS 旁）应有邮件提醒入口');
    assert.match(home, /href="\/subscribe"/);
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
    assert.match(html, /请至少填写一个关键词、选择一个领域或一个发布机关；或改选「订全部新公示」。/);
    assert.equal(readOutbox().length, 0);
  });

  it('抓取入库后无任何订阅，提醒任务空转不发信', async () => {
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /源 npc 抓取完成：列表 3 条，新增 3，更新 0/);
    assert.match(run.output, /没有可通知的订阅（需已确认且未退订），截止提醒任务跳过/);
    assert.equal(readOutbox().length, 0);
  });

  it('alice 提交订阅：创建待确认订阅并发确认邮件（含确认与退订链接）', async () => {
    const response = await postSubscription({ email: ALICE, keywords: '噪声污染防治' });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location'), /sent=1/);
    const { html } = await followGet(`${app.url}/subscribe?sent=1`);
    // 文案对「已订阅（规则已更新）」与「新订阅（已发确认信）」两种分支都成立（issue #52：
    // 区分这两种回复等于给匿名者一个「该邮箱是否已确认订阅」的枚举 oracle）
    assert.match(html, /data-testid="subscribe-sent-banner"/);
    assert.match(html, /请查收确认邮件并点击确认链接/);
    assert.match(html, /新订阅在确认前不生效/);
    assert.ok(
      !html.includes('规则已立即更新'),
      '横幅不能声称"已立即生效"：既违反 double opt-in，也给匿名者一个"该邮箱是否已确认"的枚举 oracle',
    );

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

    // 退订 token 不轮换（issue #52）：它印在每一封发出的邮件底部，轮换会让旧邮件里的
    // 退订链接全部失效（点开只得到「退订链接无效」），而口径是「每封邮件都可退订」。
    assert.equal(
      new URL(extractLink(mails[1].text, '/unsubscribe')).searchParams.get('token'),
      new URL(extractLink(mails[0].text, '/unsubscribe')).searchParams.get('token'),
      '重新提交不该轮换退订 token',
    );

    const oldResult = await followGet(oldLink);
    assert.match(oldResult.html, /确认链接无效/, '旧确认链接应落到「无效」状态页');
    assert.match(oldResult.html, /data-testid="subscribe-confirm-status"/);
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
    assert.match(run.output, /没有可通知的订阅（需已确认且未退订），截止提醒任务跳过/);
    assert.equal(readOutbox().length, 3, 'outbox 应只有 3 封确认邮件，无任何提醒');
  });

  it('确认动作只在 POST：打开确认链接（GET）不确认，点按钮才生效', async () => {
    const aliceLink = extractLink(mailsTo(ALICE)[1].text, '/subscribe/confirm');
    const aliceToken = new URL(aliceLink).searchParams.get('token');

    // 1) 邮件网关预取（GET）只落到只读确认页 —— 这正是 issue #52 要修的东西：
    //    从前 GET 直接写库，预取即确认，邮箱主人毫不知情还赔掉那个确认链接
    const prefetch = await followGet(aliceLink);
    assert.match(prefetch.html, /data-testid="subscribe-confirm-submit"/, '确认页应给出确认按钮');
    assert.match(prefetch.html, /确认订阅/);

    // 反向断言：GET 不写库 —— 再打开一次仍是「待确认」（若已确认，页面会渲染状态区而不是按钮）
    const again = await followGet(aliceLink);
    assert.match(
      again.html,
      /data-testid="subscribe-confirm-submit"/,
      'GET 预取不得确认订阅（页面应仍处于待确认）',
    );

    // 2) 点按钮（POST）才真正确认
    const aliceResult = await postConfirm(aliceToken);
    assert.match(aliceResult.response.url, /\/subscribe\/confirmed$/);
    assert.match(aliceResult.html, /订阅已确认/);
    assert.match(aliceResult.html, /截止前 7 天、3 天各发送一封提醒邮件/);

    const bobLink = extractLink(mailsTo(BOB)[0].text, '/subscribe/confirm');
    const bobResult = await postConfirm(new URL(bobLink).searchParams.get('token'));
    assert.match(bobResult.response.url, /\/subscribe\/confirmed$/);
    assert.match(bobResult.html, /订阅已确认/);
  });

  it('提醒触发时机与内容：+7 一封、+3 一封；关键词命中标题 / 正文均触发', async () => {
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /截止提醒任务完成：候选条目 3，订阅 2，发送 3 封/);

    const deadlineD7 = await servedDeadline('t20260910_210001');
    const deadlineD3 = await servedDeadline('t20260910_210002');
    const noiseId = noticeIdFor(officialUrlOf('t20260910_210001'));
    const idCardId = noticeIdFor(officialUrlOf('t20260910_210002'));

    // alice：+7（标题命中）+ +3（正文命中「医疗保障」）
    const aliceD7 = assertOneMail(ALICE, TITLES.noiseD7);
    assert.match(aliceD7.subject, /剩 7 天/);
    assert.match(aliceD7.text, new RegExp(`截止日期：${deadlineD7}（还剩 7 天`));
    assert.ok(
      aliceD7.text.includes(`${app.url}/notices/${noiseId}`),
      `提醒应含站内详情链接 ${app.url}/notices/${noiseId}：${aliceD7.text}`,
    );
    assert.ok(
      aliceD7.text.includes(officialUrlOf('t20260910_210001')),
      '提醒应含官方原文（提意）链接',
    );
    assert.match(aliceD7.text, /unsubscribe\?token=/);

    const aliceD3 = assertOneMail(ALICE, TITLES.idCardD3);
    assert.match(aliceD3.subject, /剩 3 天/);
    assert.match(aliceD3.text, new RegExp(`截止日期：${deadlineD3}（还剩 3 天`));
    assert.ok(aliceD3.text.includes(`${app.url}/notices/${idCardId}`));
    assert.ok(
      aliceD3.text.includes(officialUrlOf('t20260910_210002')),
      '官方原文链接应指向该条目的详情页地址',
    );

    // bob：仅 +7 一封（其规则不含「医疗保障」，正文命中的条目不触发）
    const bobD7 = assertOneMail(BOB, TITLES.noiseD7);
    assert.match(bobD7.subject, /剩 7 天/);
    assert.equal(
      reminderMailsTo(BOB).filter((mail) => mail.subject.includes(TITLES.idCardD3)).length,
      0,
      'bob 不应收到规则外条目的提醒',
    );

    // 每位订阅者每条目只 1 封（同邮箱单行，未重复建行）
    for (const email of [ALICE, BOB]) {
      const noiseMails = reminderMailsTo(email).filter((mail) => mail.subject.includes(TITLES.noiseD7));
      assert.equal(noiseMails.length, 1, `${email} 对同一条目只应收到 1 封提醒`);
    }

    // 匹配规则外的条目（渔业法，+7 但无人命中）不发送
    const fisheryMails = reminderOutbox().filter((mail) => mail.subject.includes(TITLES.fisheryD7));
    assert.equal(fisheryMails.length, 0);
  });

  it('重复运行提醒任务：不重发任何邮件（条目×档×订阅去重）', async () => {
    // 先跑一轮把「本轮该发的」发完。窗口化（issue #60）之后这一轮**可能补发某一档** ——
    // 那是补上以前会因为停摆一天而永远丢掉的提醒，不属于重发。
    // 所以这里不能用「第一次运行也必须 0 封」当断言（那等于把旧的精确档规则钉死）；
    // 幂等性的准确测法是：稳定一轮之后，再跑必须绝对静默。
    const warm = await runWorkerOnce();
    assert.equal(warm.code, 0, `worker 应正常退出，输出：${warm.output}`);

    const before = reminderOutbox().length;
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /发送 0 封，去重跳过 \d+ 次/, '到档且已发过的组合应全部走去重分支');
    assert.equal(reminderOutbox().length, before, '重复运行不得重发提醒');
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

    const before = reminderOutbox().length;
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /截止提醒任务完成.*发送 1 封/);
    assert.equal(reminderOutbox().length, before + 1);

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
      reminderMailsTo(BOB).filter((mail) => mail.subject.includes(EXTRA.categoryD7.title)).length,
      0,
      'bob 不应收到领域命中的提醒（其订阅无领域规则）',
    );
  });

  it('再次重复运行仍不重发', async () => {
    const before = reminderOutbox().length;
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /截止提醒任务完成.*发送 0 封/);
    assert.equal(reminderOutbox().length, before);
  });

  it('退订链接是只读确认页（issue #34）：打开不退订，点确认才退订；无效链接展示失败态', async () => {
    const aliceMail = assertOneMail(ALICE, TITLES.noiseD7);
    const unsubscribeLink = extractLink(aliceMail.text, '/unsubscribe');

    // ① 邮件正文里的链接指向**只读**确认页：GET 不改状态（邮件网关会预取这个链接，
    //    旧实现是 GET 直接退订 —— 用户会在毫不知情的情况下被退订）
    const confirmPage = await followGet(unsubscribeLink);
    assert.equal(confirmPage.response.status, 200, '确认页应是 200（不是 303 直跳结果页）');
    assert.match(confirmPage.html, /data-testid="unsubscribe-confirm"/);
    assert.match(confirmPage.html, /data-testid="unsubscribe-submit"/);
    assert.match(confirmPage.html, /action="\/unsubscribe\/one-click"/);
    assert.match(confirmPage.html, /method="post"/i);
    assert.ok(
      !/data-testid="unsubscribe-status"/.test(confirmPage.html),
      '此时应仍是「可退订」状态（GET 没有退订）',
    );

    // ② 提交确认按钮（POST）才真的退订
    const token = new URL(unsubscribeLink).searchParams.get('token');
    const posted = await fetch(`${app.url}/unsubscribe/one-click`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      redirect: 'follow',
    });
    assert.match(posted.url, /\/unsubscribe\/done\?ok=1/);
    assert.match(await posted.text(), /退订已立即生效/);

    // ③ 退订后同一链接的确认页显示「已退订」，不再提供按钮（同时反证 ① 的 GET 无副作用）
    const afterUnsubscribe = await followGet(unsubscribeLink);
    assert.match(afterUnsubscribe.html, /data-testid="unsubscribe-status"/);
    assert.match(afterUnsubscribe.html, /已经退订过/);

    // ④ 无效 token：确认页与动作端点都如实报错
    const invalid = await followGet(`${app.url}/unsubscribe?token=bogus-token`);
    assert.equal(invalid.response.status, 200);
    assert.match(invalid.html, /退订链接无效/);
    const invalidPost = await fetch(`${app.url}/unsubscribe/one-click?token=bogus-token`, {
      method: 'POST',
      redirect: 'follow',
    });
    assert.match(invalidPost.url, /ok=0/);
    assert.match(await invalidPost.text(), /退订链接无效/);
  });

  it('邮件头带 RFC 8058 一键退订（List-Unsubscribe / -Post），客户端退订按钮走 POST', async () => {
    const aliceMail = assertOneMail(ALICE, TITLES.noiseD7);
    const headers = aliceMail.headers ?? {};
    assert.match(
      headers['List-Unsubscribe'] ?? '',
      /^<https?:\/\/[^>]+\/unsubscribe\/one-click\?token=[A-Za-z0-9_-]+>$/,
      `List-Unsubscribe 应指向动作端点，实际：${headers['List-Unsubscribe']}`,
    );
    assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');

    // 客户端按 RFC 8058 用 POST + 该请求体调用（token 在查询串里）—— 立即生效
    const oneClickUrl = headers['List-Unsubscribe'].slice(1, -1);
    const response = await fetch(oneClickUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      redirect: 'manual',
    });
    assert.equal(response.status, 303, '一键退订应 303 到结果页');
    assert.match(response.headers.get('location') ?? '', /\/unsubscribe\/done\?ok=1/);

    // 一键退订地址被「人」用 GET 打开时落到确认页，而不是 405 或直接退订
    const asGet = await fetch(oneClickUrl, { redirect: 'manual' });
    assert.equal(asGet.status, 303);
    assert.match(asGet.headers.get('location') ?? '', /^\/unsubscribe\?token=/);
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

    // alice 已退订：其规则同样命中该条目，但不再收到任何邮件。
    // 基线取"本轮之前的实际封数"而不是写死 5 —— 补发会让历史封数变化，
    // 这条断言要表达的是「退订之后一封都不再加」，不是「她一共只该收到几封」。
    const aliceBefore = mailsTo(ALICE).length;
    const before = reminderOutbox().length;
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /截止提醒任务完成.*发送 1 封/);
    assert.equal(reminderOutbox().length, before + 1);

    // bob（未退订，关键词命中标题）收到新条目提醒
    const bobMail = assertOneMail(BOB, EXTRA.keywordD3.title);
    assert.match(bobMail.subject, /剩 3 天/);
    assert.ok(bobMail.text.includes(EXTRA.keywordD3.url));

    const aliceMailsAfter = mailsTo(ALICE).filter((mail) =>
      mail.subject.includes(EXTRA.keywordD3.title),
    );
    assert.equal(aliceMailsAfter.length, 0, '退订后不得再收到任何提醒');
    assert.equal(
      mailsTo(ALICE).length,
      aliceBefore,
      `退订前 alice 已有 ${aliceBefore} 封，本轮之后必须一封都不多`,
    );
  });

  // 放在文件末尾：详情页断言需要库内已有条目（本文件在前面才跑抓取）
  it('邮件端口可用时详情页出现订阅提醒入口（最高意向时刻）', async () => {
    const listHtml = await (await fetch(`${app.url}/`)).text();
    const matched = /href="\/notices\/([0-9a-f]+)"/.exec(listHtml);
    assert.ok(matched, '首页应有条目链接（前面的用例已完成抓取）');

    const detail = await (await fetch(`${app.url}/notices/${matched[1]}`)).text();
    assert.match(detail, /data-testid="subscribe-detail-link"/, '详情页应有订阅提醒入口');
    assert.match(detail, /截止前 7 天、3 天各收一封提醒邮件/, '入口应说明提醒时机');
  });
});
