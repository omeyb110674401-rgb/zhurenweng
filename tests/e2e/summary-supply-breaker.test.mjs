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
 * E2E（issue #84）：摘要任务的**熔断** —— LLM 供给中断时不再逐条跑满重试。
 *
 * 触发面是 2026-10-13 的生产实况：中转站月度额度打满（HTTP 429 `GoUsageLimitError` /
 * `limitName: monthly`），3 条待摘要全部走满 4 次尝试后转人工复核 —— 白打 12 次出境调用、
 * 留 12 行失败日志。那天只有 3 条；待摘要有 50 条的日子就是 200 次。
 *
 * 本文件钉住四件事（每一件都对应一个具体的、会静默退化的失效方式）：
 *   1. 供给中断 ⇒ **不重试**（单条 1 次调用，不是 4 次）—— 退避重试对"额度已满"毫无意义；
 *   2. 连续 2 条 ⇒ **熔断本轮**，剩余的条目**一次 LLM 都没调**就转人工复核；
 *   3. 内容族失败（stub 的原样失败）⇒ **照旧跑满 3 次重试、不熔断** ——
 *      否则一条脏数据就能把整轮推去人工复核；
 *   4. 供给中断与内容失败的**日志措辞不同**（"未重试"vs"已重试 3 次"）——
 *      把自己的编排说成另一个样子，会让排查的人去查"为什么重试没好"。
 *
 * 全程零外部依赖（ADR-0001）：SQLite 临时库 + 本地 fixture 源站 + stub LLM。
 * 供给中断由 `LLM_STUB_FAILURE_MODE=supply` 注入（样本逐字取自生产日志）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-breaker-'));
const dbFile = path.join(workDir, 'app.db');
const callsFile = path.join(workDir, 'llm-calls.jsonl');
const tempFixturesDir = path.join(workDir, 'fixtures');

let app;
let fixtures;
let fixtureUrl;

/** 单轮运行真实 worker 子进程，extraEnv 仅注入本次运行。 */
function runWorkerOnce(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['worker/index.ts'], {
      cwd: repoRoot,
      env: { ...process.env, WORKER_ONCE: '1', ...extraEnv },
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

function readCalls() {
  if (!fs.existsSync(callsFile)) return [];
  return fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean);
}

function matchCount(text, regex) {
  return (text.match(regex) ?? []).length;
}

before(async () => {
  fs.cpSync(path.join(repoRoot, 'fixtures', 'npc'), path.join(tempFixturesDir, 'npc'), {
    recursive: true,
  });
  fixtures = createFixtureServer({ fixturesDir: tempFixturesDir });
  fixtureUrl = (await fixtures.start()).url;

  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      LLM_STUB_CALLS_FILE: callsFile,
      // 退避基数调小：即使走了重试路径，总耗时也可忽略
      SUMMARY_RETRY_DELAY_MS: '10',
      SOURCES_FIXTURE_BASE: fixtureUrl,
    },
  });
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('issue #84：LLM 供给中断的熔断', () => {
  it('第一轮（内容族失败）：照旧跑满重试、**不熔断** —— 反例守门', async () => {
    const run = await runWorkerOnce({ LLM_STUB_FAILURES: 'always' });
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);

    // 2 条待摘要、每条 4 次尝试 = 8 次调用：既有的重试行为一字未变
    assert.equal(readCalls().length, 8, `内容族失败仍应每条试满 4 次，输出：${run.output}`);
    assert.equal(matchCount(run.output, /已重试 3 次仍失败，转人工复核/g), 2);
    // 熔断**不该**被触发：任何一条内容族失败都不能把本轮带走
    assert.ok(!run.output.includes('熔断本轮'), `内容族失败不该熔断，输出：${run.output}`);
    assert.match(run.output, /摘要任务完成：成功 0 条，转人工复核 2 条/);
  });

  it('第二轮（供给中断）：第一条只试 1 次、第二条起直接熔断，剩余条目零调用', async () => {
    // 第一轮已把 2 条打成 failed_review，本轮先手工放回 pending —— 否则队列是空的，
    // "熔断时跳过剩余条目"这件事根本没有剩余条目可跳，测试会假绿。
    //
    // 刻意**不走** `scripts/reset-summaries-for-redraft.mjs`：那个脚本有自己的候选判据
    // （排除已截止、排除人工复核录入等，见它的模块头），用在这里等于让本测试的结果
    // 取决于另一个工具的筛选规则 —— 那条规则以后放宽或收紧，这里会跟着变，
    // 而失败信息会指向熔断、实际原因在别处。直接改这一列，测的就是熔断本身。
    const reset = spawn(
      process.execPath,
      [
        '-e',
        'const D=require("better-sqlite3");' +
          'const db=new D(process.env.DATABASE_URL);' +
          'const n=db.prepare("UPDATE notices SET summary_status=\'pending\' WHERE summary_status=\'failed_review\'").run().changes;' +
          'console.log("reset",n);',
      ],
      { cwd: repoRoot, env: { ...process.env, DATABASE_URL: dbFile } },
    );
    let resetOut = '';
    reset.stdout.on('data', (c) => (resetOut += c));
    reset.stderr.on('data', (c) => (resetOut += c));
    const resetCode = await new Promise((resolve) => reset.on('close', resolve));
    assert.equal(resetCode, 0, `重置应成功，输出：${resetOut}`);
    assert.match(resetOut, /reset 2/, `应有 2 条被放回 pending，输出：${resetOut}`);

    const before = readCalls().length;
    const run = await runWorkerOnce({
      LLM_STUB_FAILURES: 'always',
      LLM_STUB_FAILURE_MODE: 'supply',
    });
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);

    const callsThisRound = readCalls().length - before;
    // 这是本条测试的**核心断言**：供给中断下，每条只试 1 次，且阈值（2）一到就停。
    // 老行为会是 8 次（2 条 × 4 次）；新行为是 2 次（两条各 1 次首调，第 2 条触发熔断）。
    assert.equal(
      callsThisRound,
      2,
      `供给中断应让每条只试 1 次、连续 2 条即熔断（共 2 次调用），实际 ${callsThisRound} 次，输出：${run.output}`,
    );

    // 熔断那一行必须说清"熔断了、连续几条、为什么"。
    // 注意本场景 fixture 只有 2 条待摘要、阈值也是 2 ⇒ 第 2 条中招时**没有剩余条目**，
    // 所以走的是"恰好跑完"那一句。这不是文字游戏：宣布"剩余 0 条转人工复核"是在说
    // 一件没发生的事，而这个项目对"说得比事实多"有过明确教训。
    assert.match(run.output, /连续 2 条 LLM 供给中断/);
    assert.match(run.output, /本轮恰好跑完，无剩余条目可跳/);
    assert.ok(
      !run.output.includes('剩余 0 条不再调用'),
      `没有剩余条目时不该宣布跳过了条目，输出：${run.output}`,
    );

    // 措辞要准：供给中断那两条是"未重试"，**不是**"已重试 3 次"
    assert.equal(
      matchCount(run.output, /已重试 3 次仍失败，转人工复核/g),
      0,
      `供给中断不该被说成"已重试 3 次"，输出：${run.output}`,
    );
    assert.match(run.output, /LLM 供给中断，未重试，转人工复核/);

    // 两条都被转人工复核（一条因供给中断、一条因熔断），页面上不该还显示"生成中"
    assert.match(run.output, /摘要任务完成：成功 0 条，转人工复核 2 条/);
  });

  it('第三轮：额度恢复后供给中断的条目不再自动重试（failed_review 是终态）', async () => {
    // 用户拍板的语义：熔断跳过 = 与"重试耗尽"同等终态。恢复后**不会**自己补跑，
    // 要人工用 scripts/summarize-now.mjs 点名。这条钉住那个语义，免得以后有人
    // 觉得"额度回来了就该自动补"而静默改掉它。
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /无待摘要条目/, `failed_review 不该再进队列，输出：${run.output}`);
  });

  it('第四轮：阈值=1 时第一条就熔断，**剩余条目被跳过**且零调用', async () => {
    // 这一条才真正覆盖熔断的核心价值：把队列里**还没跑**的条目救下来。
    // 第二轮的 fixture 只有 2 条、阈值也是 2，第 2 条中招时已经没有剩余 —— 那里
    // 验的是"不谎报跳过了几条"，不是"真的跳过了几条"。把阈值降到 1 ⇒ 第 1 条中招，
    // 第 2 条应当**一次调用都没有**地被置为 failed_review。
    const reset = spawn(
      process.execPath,
      [
        '-e',
        'const D=require("better-sqlite3");' +
          'const db=new D(process.env.DATABASE_URL);' +
          'const n=db.prepare("UPDATE notices SET summary_status=\'pending\' WHERE summary_status=\'failed_review\'").run().changes;' +
          'console.log("reset",n);',
      ],
      { cwd: repoRoot, env: { ...process.env, DATABASE_URL: dbFile } },
    );
    let resetOut = '';
    reset.stdout.on('data', (c) => (resetOut += c));
    reset.stderr.on('data', (c) => (resetOut += c));
    assert.equal(
      await new Promise((resolve) => reset.on('close', resolve)),
      0,
      `重置应成功，输出：${resetOut}`,
    );
    assert.match(resetOut, /reset 2/);

    const before = readCalls().length;
    const run = await runWorkerOnce({
      LLM_STUB_FAILURES: 'always',
      LLM_STUB_FAILURE_MODE: 'supply',
      SUMMARY_SUPPLY_BREAKER_THRESHOLD: '1',
    });
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);

    // 阈值 1 ⇒ 第 1 条中招立刻熔断 ⇒ 本轮 LLM 调用**恰好 1 次**
    //（老行为：2 条 × 4 次 = 8 次）
    const callsThisRound = readCalls().length - before;
    assert.equal(
      callsThisRound,
      1,
      `阈值 1 时第 1 条中招就该停手（共 1 次调用），实际 ${callsThisRound} 次，输出：${run.output}`,
    );

    // 第 2 条应被显式跳过并落失败态
    assert.match(run.output, /剩余 1 条不再调用，转人工复核/);
    assert.match(run.output, /因熔断跳过，转人工复核/);
    assert.match(run.output, /本轮因熔断提前结束：未调用 LLM 的条目 1 条已转人工复核/);
    assert.match(run.output, /摘要任务完成：成功 0 条，转人工复核 2 条/);
  });
});
