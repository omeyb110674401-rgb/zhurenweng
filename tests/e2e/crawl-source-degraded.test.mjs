import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { startAppServer } from './helpers/app-server.mjs';
import { createFixtureServer } from './helpers/fixture-server.mjs';

/**
 * E2E（issue #51）：源站改版让详情全部抓不到时，不能再报「抓取完成、源健康」。
 *
 * 三轮，同一个源（npc，7 条）：
 * 1. **详情齐全** → 逐条失败 0 → 不判降级（狼来了比漏报更伤告警信誉）；
 * 2. **详情快照全删**（详情页全 404）→ 逐条失败 7/7 过半 → 必须判降级：
 *    日志明说、发告警邮件、源标成不健康；
 * 3. **详情恢复** → 回到健康（降级不是单向标记）。
 *
 * 旧行为：详情失败被逐条吞掉（这是对的 —— 一条坏数据不该拖垮整源），但完成日志照样打
 * 「抓取完成」、源照样标健康：健康看板全绿、告警不响，正文 / 截止日期 / 附件静默烂掉。
 *
 * 全程零外部依赖（ADR-0001）：SQLite 临时库 + 本地 fixture 源站 + stub 邮件（JSONL outbox）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceFixturesDir = path.join(repoRoot, 'fixtures', 'e2e-versions-degraded');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue51-'));
const fixturesDir = path.join(workDir, 'fixtures');
const dbFile = path.join(workDir, 'app.db');
const outboxFile = path.join(workDir, 'outbox.jsonl');

const ALERT_EMAIL = 'ops@zhurenweng.example';
/** 该 fixture 的 npc 列表条数与详情快照数（删完应当正好是这个数）。 */
const LIST_COUNT = 7;

let app;
let fixtures;

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

/** 读取 stub 邮件 outbox（JSONL）。 */
function readOutbox() {
  if (!fs.existsSync(outboxFile)) return [];
  return fs
    .readFileSync(outboxFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * 只取与本测试源（npc）有关的告警。
 *
 * 为什么必须过滤：fixture 根目录只提供 npc 一个源，其余九个源的列表页会 404 ——
 * 那是**真实**的源级失败，本来就会各发一封告警（告警去重是「同日 × 任务 × 源」）。
 * 断言「一共只有一封邮件」会被这些无关告警打假红；本测试关心的是 npc 的**数据质量**
 * 告警，所以按源过滤。
 */
function npcAlerts() {
  return readOutbox().filter(
    (mail) => mail.to === ALERT_EMAIL && /npc/.test(`${mail.subject ?? ''}\n${mail.text ?? ''}`),
  );
}

/** 删掉该源全部详情快照（模拟源站改版 / 详情页全挂）。返回删掉的文件数。 */
function removeAllDetailFiles() {
  const detailRoot = path.join(fixturesDir, 'npc', 'flca');
  let removed = 0;
  for (const entry of fs.readdirSync(detailRoot)) {
    const file = path.join(detailRoot, entry, 'info', 'index.json');
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      removed += 1;
    }
  }
  return removed;
}

before(async () => {
  fs.cpSync(sourceFixturesDir, fixturesDir, { recursive: true });

  fixtures = createFixtureServer({ fixturesDir });
  const fixtureUrl = (await fixtures.start()).url;

  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      MAILER_OUTBOX_FILE: outboxFile,
      FIXTURES_DIR: fixturesDir,
      SOURCES_FIXTURE_BASE: fixtureUrl,
      SITE_URL: 'https://zw.test',
      ALERT_EMAIL,
    },
  });
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('issue #51：源数据质量降级必须说话', () => {
  it('第一轮（详情齐全）：不判降级、不发告警', async () => {
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出：${run.output}`);
    assert.match(run.output, new RegExp(`源 npc 抓取完成：列表 ${LIST_COUNT} 条`));
    assert.ok(!/源 npc 数据质量降级/.test(run.output), `不该误报降级：${run.output}`);
    assert.deepEqual(npcAlerts(), [], 'npc 不该有告警（其余源的 404 与本源无关）');
  });

  it('第二轮（详情全 404）：判降级 —— 日志写明 + 告警邮件', async () => {
    const removed = removeAllDetailFiles();
    assert.equal(removed, LIST_COUNT, `应删掉 ${LIST_COUNT} 个详情快照，实际 ${removed}`);

    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `降级不是崩溃，worker 仍应正常退出：${run.output}`);
    assert.match(run.output, /源 npc 数据质量降级/, `应明说降级：${run.output}`);
    assert.match(run.output, new RegExp(`本轮 ${LIST_COUNT} 条里 ${LIST_COUNT} 条详情失败`));
    assert.match(run.output, /详情失败 7，入库失败 0/, '完成日志也要带上失败计数');

    const alerts = npcAlerts();
    assert.equal(alerts.length, 1, `npc 应恰好一封降级告警：${JSON.stringify(readOutbox())}`);
    const alertText = `${alerts[0].subject ?? ''}\n${alerts[0].text ?? ''}`;
    assert.match(alertText, /详情失败/, '告警要说清是「详情大面积失败」而非笼统失败');
    assert.match(alertText, /数据可能已停止更新/, '告警要说明后果，而不只是报个错');
  });

  it('第三轮（详情恢复）：回到健康 —— 降级不是单向标记', async () => {
    fs.cpSync(sourceFixturesDir, fixturesDir, { recursive: true });

    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出：${run.output}`);
    assert.ok(!/源 npc 数据质量降级/.test(run.output), `恢复后不该再报降级：${run.output}`);
    assert.match(run.output, new RegExp(`源 npc 抓取完成：列表 ${LIST_COUNT} 条`));
  });
});
