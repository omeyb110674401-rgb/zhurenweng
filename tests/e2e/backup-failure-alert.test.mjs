import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { resolveBash } from './helpers/bash.mjs';

/**
 * 端到端（issue #71）：备份脚本**失败时真的会去发信**，成功时一封都不发。
 *
 * 为什么要用 bash 跑真脚本而不是只测 JS 那一侧：这套告警的关键性质全在 shell 的 trap 上 ——
 * 「失败要发一封」「ERR 与 EXIT 两个 trap 不能各发一封（变成两封）」「成功不能发」
 * 「告警脚本自己的成败不能盖掉备份的退出码」。这些用读代码的方式都"看起来对"，
 * 而 issue #68 已经证明过一次"看起来对"的调度可以整天不干活。
 *
 * 做法：造一个假的 `docker` 放进 PATH，它把每次调用记到 DOCKER_LOG，并按 FAIL_AT 决定
 * 哪一步故意失败。脚本本体用仓库里那份**原样**跑（复制文件，不改逻辑）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIM = `#!/bin/sh
echo "docker $*" >> "$DOCKER_LOG"
case "$*" in
  *pg_dump*)
    if [ "$FAIL_AT" = "dump" ]; then exit 7; fi
    # 只往 stdout 写 20000 字节：重定向是脚本自己做的（> "$FILE.part"），桩不碰文件名
    awk 'BEGIN{for(i=0;i<20000;i++)printf "x"}'
    exit 0 ;;
  *psql*)
    # FAIL_AT=verify ⇒ 让"恢复后的库"少一条，触发脚本里那处显式 exit 1
    if [ "$FAIL_AT" = "verify" ]; then
      case "$*" in *zw_backup_verify*) echo 4 ;; *) echo 5 ;; esac
    else
      echo 5
    fi
    exit 0 ;;
esac
exit 0
`;

/** 跑一次脚本副本，返回退出码、docker 调用记录与脚本自己的输出。 */
function runBackup({ failAt }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-backup-alert-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const dockerPath = path.join(bin, 'docker');
  fs.writeFileSync(dockerPath, SHIM, { mode: 0o755 });
  const root = path.join(dir, 'root');
  fs.mkdirSync(root, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'deploy', 'daily-backup.sh'), path.join(root, 'daily-backup.sh'));
  const log = path.join(dir, 'docker.log');
  fs.writeFileSync(log, '');

  // 必须是真 bash（脚本用了 trap / `2>&1` 这类 sh 兼容语法）；`resolveBash()` 会把
  // 「PATH 上的 bash 其实是 WSL 启动器」这种情况绕开，见该 helper 的模块注释。
  const run = spawnSync(resolveBash(), ['daily-backup.sh'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      ROOT: root,
      DEST: path.join(dir, 'dest'),
      KEEP: '7',
      DOCKER_LOG: log,
      FILE: path.join(dir, 'dest', 'planned.dump'),
      FAIL_AT: failAt ?? '',
    },
  });
  return {
    code: run.status,
    calls: fs.readFileSync(log, 'utf8').trim().split('\n').filter((line) => line !== ''),
    output: `${run.stdout}\n${run.stderr}`,
  };
}

describe('issue #71：每日备份失败要发一封告警', () => {
  it('导出失败 ⇒ 非零退出码保留，且恰好发一封（ERR 与 EXIT 两个 trap 不各发一封）', () => {
    const { code, calls } = runBackup({ failAt: 'dump' });
    assert.notEqual(code, 0, `备份失败必须带非零退出码，实际 ${code}`);
    assert.equal(code, 7, '原始退出码不能被告警路径盖掉');
    const alerts = calls.filter((line) => line.includes('alert-backup-failure.mjs'));
    assert.equal(alerts.length, 1, `应当恰好一封，实际：${JSON.stringify(alerts)}`);
    assert.match(alerts[0], /阶段=导出/, '邮件里要带阶段名，否则收信人得猜是哪一步挂了');
    assert.match(alerts[0], /退出码=7/);
  });

  it('校验对不上（脚本自己 exit 1）⇒ 仍然恰好一封，且带阶段=恢复校验', () => {
    // 这一条测的是 **EXIT trap**：`exit 1` 不是"命令失败"，ERR trap 抓不到，
    // 少了 EXIT trap 就会变成"校验失败但没人知道"—— 而那正是最不能静默的失败方式
    const { code, calls } = runBackup({ failAt: 'verify' });
    assert.notEqual(code, 0, '校验不通过必须非零退出');
    const alerts = calls.filter((line) => line.includes('alert-backup-failure.mjs'));
    assert.equal(alerts.length, 1, `应当恰好一封，实际：${JSON.stringify(alerts)}`);
    assert.match(alerts[0], /阶段=恢复校验/);
    assert.match(alerts[0], /恢复后 4 条/);
  });

  it('全程顺利 ⇒ 一封都不发（天天发"备份成功"就等于没有信号）', () => {
    const { code, calls, output } = runBackup({ failAt: null });
    assert.equal(code, 0, `脚本应当成功，输出：${output}`);
    assert.match(output, /备份完成/);
    assert.deepEqual(
      calls.filter((line) => line.includes('alert-backup-failure.mjs')),
      [],
      '成功路径不该产生任何告警调用',
    );
  });
});

/** 直接跑告警脚本本体（stub mailer + 临时 SQLite），验的是"真能写出一封信 + 绝不非零退出"。 */
function runAlertScript({ mailerFailures = '', alertEmail = '站长@example.test', dbFile } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-alert-script-'));
  // 去重键落在库里 ⇒ 测去重的两次调用必须共用同一个数据库文件，否则各测各的空库
  const databaseUrl = dbFile ?? path.join(dir, 'app.db');
  const outbox = path.join(dir, 'outbox.jsonl');
  const run = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'alert-backup-failure.mjs'),
    '每日数据库备份失败（阶段=恢复校验；退出码=1）'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      DB_DRIVER: 'sqlite',
      DATABASE_URL: databaseUrl,
      MAILER_PROVIDER: 'stub',
      MAILER_OUTBOX_FILE: outbox,
      MAILER_STUB_FAILURES: mailerFailures,
      ALERT_EMAIL: alertEmail,
      LLM_PROVIDER: 'stub',
      ATTACHMENT_TEXT: 'off',
    },
  });
  return {
    code: run.status,
    out: `${run.stdout}
${run.stderr}`,
    outbox: fs.existsSync(outbox)
      ? fs.readFileSync(outbox, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      : [],
  };
}

describe('issue #71：告警脚本自己（复用 worker 的告警出口）', () => {
  it('配了 ALERT_EMAIL ⇒ 真写出一封，内容带上阶段与退出码', () => {
    const { code, out, outbox } = runAlertScript();
    assert.equal(code, 0, `脚本必须零退出，输出：${out}`);
    assert.equal(outbox.length, 1, `outbox 应当恰好一行，实际：${JSON.stringify(outbox)}`);
    assert.match(outbox[0], /每日数据库备份失败/);
    assert.match(outbox[0], /阶段=恢复校验/);
    assert.match(outbox[0], /daily-backup/, '任务名要能认出来是备份，而不是某个抓取源');
  });

  it('同一天的第二次 ⇒ 被去重挡掉（连续坏三天只发一封，不刷屏）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-alert-dedup-'));
    const dbFile = path.join(dir, 'shared.db');
    const first = runAlertScript({ dbFile });
    assert.equal(first.outbox.length, 1, `第一次应当真发出去，实际：${first.out}`);
    const second = runAlertScript({ dbFile });
    assert.match(second.out, /未送出|当日已发过/, `第二次应被去重，实际：${second.out}`);
  });

  /**
   * issue #83：告警**内容**要留在库里。
   *
   * 此前 alert_sends 只有（哪天 × 任务 × 源 × 发送时间）—— 09-21 起站长收到过十几封告警，
   * 事后想复盘"当时到底报了什么"只能去翻收件箱，而收件箱不是留痕的地方。
   * 这条断言跑的是真脚本 + 真 SQLite：写进去的必须与邮件正文里那段摘要同源。
   */
  it('告警落库留痕：alert_sends 记下那封邮件说了什么（issue #83）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-alert-summary-'));
    const dbFile = path.join(dir, 'shared.db');
    const { code, out, outbox } = runAlertScript({ dbFile });
    assert.equal(code, 0, `脚本必须零退出，输出：${out}`);
    assert.equal(outbox.length, 1, '这一条要有真邮件，否则留痕无从谈起');

    const db = new Database(dbFile, { readonly: true });
    let row;
    try {
      row = db
        .prepare('select alert_date, job_name, source_id, sent_at, error_summary from alert_sends')
        .get();
    } finally {
      db.close();
    }
    assert.ok(row, 'alert_sends 应有一行去重标记');
    assert.equal(row.job_name, 'daily-backup');
    assert.match(
      row.error_summary ?? '',
      /每日数据库备份失败/,
      '库里要存下那封告警说了什么，而不是只有时间与任务名',
    );
    // 与真正发出去的那封信同源：同一个字符串既进了邮件，也进了库
    assert.ok(
      outbox[0].includes(row.error_summary),
      '库里存的摘要应当是邮件里那段（不是另写一句概括）',
    );
  });

  it('发信本身失败 ⇒ 仍然零退出（不能把备份的退出码换成告警脚本的）', () => {
    const { code, out } = runAlertScript({ mailerFailures: 'always' });
    assert.equal(code, 0, `发信失败也必须零退出，输出：${out}`);
    assert.match(out, /发送失败|未送出/);
  });

  it('没配 ALERT_EMAIL ⇒ 安静跳过且零退出', () => {
    const { code, out, outbox } = runAlertScript({ alertEmail: '' });
    assert.equal(code, 0, `输出：${out}`);
    assert.deepEqual(outbox, [], '未配置收件人时不该发任何东西');
    assert.match(out, /未配置 ALERT_EMAIL/);
  });
});
