import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { createFixtureServer } from './helpers/fixture-server.mjs';

/**
 * E2E（issue #58）：间歇性失败的源不能再「每天红一次、每天一封邮件」。
 *
 * 线上形态就是 cac 之外的 npc：列表页偶发超时 → 失败一次即 `healthy=0`，而成功后
 * 错误列不清空（当时的理由是「便于排查曾停摆的源」），告警又只按日历日去重 ——
 * 于是看板上永远像正在出事、信箱里每天一封同样的邮件。噪声的日常化比漏报更糟：
 * 它会训练人跳过那封邮件。
 *
 * 四轮，同一个源（cac）：
 * 1. 抖一次 → 只**记录**（计数 1、错误列有值、看板仍是健康），**不发信**；
 * 2. 连抖两次 → 判红 + 恰好一封，邮件里带上第一轮的原始错误（错误列成功即清，
 *    跨轮来路只能写进这一句）；
 * 3. 恢复 → 判健康、计数归零、错误列清空，且不为「恢复」发信；
 * 4. 再抖一次 → **又从第 1 轮数起**、仍判健康（抖动恢复后不该背着上次的账）。
 *
 * 「持续故障每 7 轮重发」这一段本文件测不了：几轮都跑在同一天里，必然被日历日去重
 * 盖住，分不清是计数器闭嘴还是去重闭嘴。那部分由 `tests/unit/config-guards.test.mjs`
 * 的 `shouldAlertForSourceFailure` 真值表钉。
 *
 * 全程零外部依赖（ADR-0001）：SQLite 临时库 + 本地 fixture 源站 + stub 邮件。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue58-flaky-'));
const fixturesDir = path.join(workDir, 'fixtures');
const dbFile = path.join(workDir, 'app.db');
const outboxFile = path.join(workDir, 'outbox.jsonl');

const ALERT_EMAIL = 'ops@zhurenweng.example';
/** 本测试唯一关心的源；其余源的列表 404 是无关噪声，一律按源过滤掉。 */
const SOURCE_ID = 'cac';
const LIST_FILE = path.join(fixturesDir, SOURCE_ID, 'list.html');

let fixtures;

const TITLE = '国家互联网信息办公室关于《间歇性抖动办法（征求意见稿）》公开征求意见的通知';

function writeListFixture() {
  const dir = path.join(fixturesDir, SOURCE_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'd1.htm'),
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${TITLE}</title></head>
<body><div class="main-title"><h1 class="title">${TITLE}</h1>
<div class="info clearfix"><span id="pubtime">{{CN_DATE-2}} 09:30</span></div></div>
<div class="main-content"><div id="BodyLabel"><p>间歇性抖动正文。</p>
<p>意见反馈截止日期为{{CN_DATE+20}}。</p></div></div></body></html>`,
  );
  fs.writeFileSync(
    LIST_FILE,
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>网信@你</title></head>
<body><div class="main"><div id="loadingInfoPage" class="default">
<li><h5><a href="d1.htm" target="_blank" title="${TITLE}">${TITLE}</a></h5>
<div class="times">{{DATE-2}}</div></li>
</div></div></body></html>`,
  );
}

function removeListFixture() {
  fs.rmSync(LIST_FILE, { force: true });
}

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

/** 本源的「告警已发送」日志行（精确到 job，避免把别的任务算进来）。 */
function alertLines(output) {
  return output
    .split('\n')
    .filter((line) => line.includes('任务失败告警已发送') && line.includes(`job=crawl-notices source=${SOURCE_ID}`));
}

/** 本源实际发出的告警邮件正文。 */
function alertMails() {
  if (!fs.existsSync(outboxFile)) return [];
  return fs
    .readFileSync(outboxFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .filter((mail) => `${mail.subject ?? ''}`.includes(`（${SOURCE_ID}）`));
}

function sourceRow() {
  const db = new Database(dbFile, { readonly: true });
  try {
    const row = db
      .prepare(
        `select healthy, enabled, consecutive_failures, last_success_at, last_error_message, last_error_at
           from sources where id = ?`,
      )
      .get(SOURCE_ID);
    assert.ok(row, `sources 表应有 ${SOURCE_ID} 行（轮初就要登记）`);
    return row;
  } finally {
    db.close();
  }
}

before(async () => {
  fixtures = createFixtureServer({ fixturesDir });
  const fixtureUrl = (await fixtures.start()).url;

  process.env.DB_DRIVER = 'sqlite';
  process.env.DATABASE_URL = dbFile;
  process.env.LLM_PROVIDER = 'stub';
  process.env.MAILER_PROVIDER = 'stub';
  process.env.MAILER_OUTBOX_FILE = outboxFile;
  process.env.ALERT_EMAIL = ALERT_EMAIL;
  process.env.SITE_URL = 'https://zw.test';
  process.env.FIXTURES_DIR = fixturesDir;
  process.env.SOURCES_FIXTURE_BASE = fixtureUrl;
  process.env.ATTACHMENT_TEXT = 'off';
});

after(async () => {
  await fixtures?.stop();
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('issue #58：间歇性失败的源不再每天红、每天发信', () => {
  it('第 1 轮抖动：只记录（计数 1、仍判健康）且不发邮件', async () => {
    removeListFixture();
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出：${run.output}`);

    assert.match(
      run.output,
      new RegExp(`源 ${SOURCE_ID} 抓取失败（连续第 1 轮）`),
      `日志要说清是第几轮：${run.output}`,
    );
    assert.deepEqual(alertLines(run.output), [], `首轮抖动不该发信：${run.output}`);

    const row = sourceRow();
    assert.equal(row.healthy, 1, '一次失败不判红（真出事最迟第二轮判）');
    assert.equal(row.consecutive_failures, 1);
    assert.match(row.last_error_message, /HTTP 404/, '错误列当场就要有内容，否则首轮无人知晓');
    assert.notEqual(row.last_error_at, null);
  });

  it('第 2 轮仍失败：判红 + 恰好一封，且邮件带上第一轮的原始错误', async () => {
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, run.output);

    assert.match(run.output, new RegExp(`源 ${SOURCE_ID} 抓取失败（连续第 2 轮）`));
    assert.equal(alertLines(run.output).length, 1, `应恰好一封：${run.output}`);

    const row = sourceRow();
    assert.equal(row.healthy, 0, '满门槛判红');
    assert.equal(row.consecutive_failures, 2);

    const mails = alertMails();
    assert.equal(mails.length, 1, `本源应只有一封邮件：${JSON.stringify(mails)}`);
    const text = `${mails[0].subject ?? ''}\n${mails[0].text ?? ''}`;
    assert.match(text, /上一轮：/, '错误列成功即清，跨轮来路只能写进这一句');
    assert.match(text, /HTTP 404/);
  });

  it('第 3 轮恢复：判健康、计数归零、清空当前故障态的错误列，且不为恢复发信', async () => {
    writeListFixture();
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, new RegExp(`源 ${SOURCE_ID} 抓取完成：列表 1 条`));
    assert.deepEqual(alertLines(run.output), [], '恢复不该发信');

    const row = sourceRow();
    assert.equal(row.healthy, 1);
    assert.equal(row.consecutive_failures, 0, '计数必须归零，否则下轮抖动会背着这次的账');
    assert.equal(row.last_error_message, null, '错误列只描述当前故障态：出事时才有内容');
    assert.equal(row.last_error_at, null);
    assert.notEqual(row.last_success_at, null);
  });

  it('第 4 轮再抖一次：仍从第 1 轮数起、仍判健康、仍不发信', async () => {
    removeListFixture();
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, run.output);

    assert.match(
      run.output,
      new RegExp(`源 ${SOURCE_ID} 抓取失败（连续第 1 轮）`),
      `恢复之后计数要重新开始：${run.output}`,
    );
    assert.deepEqual(alertLines(run.output), [], `抖一次不该发信：${run.output}`);

    const row = sourceRow();
    assert.equal(row.healthy, 1, '抖一次就红 = 每天都红 = 没人再看看板');
    assert.equal(row.consecutive_failures, 1);
    assert.equal(alertMails().length, 1, '四轮跑完本源总共只该有一封邮件');
  });
});
