import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { startAppServer } from './helpers/app-server.mjs';
import { createFixtureServer } from './helpers/fixture-server.mjs';
import { noticeItems, stripSsrComments } from './helpers/html.mjs';

/**
 * E2E（issue #43）：状态列每日一轮，页面不能因此说已关闭的征集还能提意见。
 *
 * 场景：抓取一轮（真实时钟）把状态写进库 → 把**测试进程的时钟**往前拨过某个条目的
 * 截止日（node:test mock.timers；应用与测试同进程，见 ADR-0001）→ 页面必须当场改口。
 *
 * 修复前的行为：徽标仍写「征求意见中」（沿用库内 status），而倒计时因为
 * `daysUntil < 0` 静默消失 —— 读者看到的是「还能提意见、没有截止提醒」，
 * 生产实测这个窗口约 14 小时（每日一轮，上一轮 14:05 北京时间）。
 *
 * 本文件不重跑 worker：两次请求之间没有任何抓取，所以库内 status 不可能变 ——
 * 徽标翻转只可能来自展示层的复核（这正是要锁定的性质）。
 *
 * 全程零外部依赖（ADR-0001）：SQLite 临时文件库 + 本地 fixture 源站 + stub 端口。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures', 'e2e-sources');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue43-'));
const dbFile = path.join(workDir, 'app.db');

const DAY_MS = 24 * 60 * 60 * 1000;

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

/** 列表页 → 条目数组（标题 / 详情链接 / 徽标 / 倒计时文案 / 倒计时的类名）。 */
function listItems(html) {
  return noticeItems(html)
    .map((block) => block.slice(0, block.indexOf('</li>')))
    .map((chunk) => ({
      href: /href="(\/notices\/[0-9a-f]+)"/.exec(chunk)?.[1] ?? null,
      title: /data-testid="notice-title-link"[^>]*>([^<]*)</.exec(chunk)?.[1] ?? '',
      badge: /data-testid="notice-status-badge"[^>]*>([^<]*)</.exec(chunk)?.[1] ?? null,
      countdown: /data-testid="notice-countdown"[^>]*>([^<]*)</.exec(chunk)?.[1] ?? null,
      countdownClass: /<span class="(countdown[^"]*)" data-testid="notice-countdown"/.exec(chunk)?.[1] ?? null,
    }));
}

/** 倒计时「剩 N 天」里的 N；「今天截止」为 0；无倒计时为 null。 */
function remainingDays(item) {
  if (item.countdown === null) return null;
  if (item.countdown === '今天截止') return 0;
  if (item.countdown === '明天截止') return 1;
  const match = /^剩 (\d+) 天$/.exec(item.countdown);
  return match ? Number(match[1]) : null;
}

async function fetchHome() {
  const response = await fetch(`${app.url}/`);
  assert.equal(response.status, 200);
  return stripSsrComments(await response.text());
}

before(async () => {
  fixtures = createFixtureServer({ fixturesDir });
  const fixtureUrl = (await fixtures.start()).url;

  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      SOURCES_FIXTURE_BASE: fixtureUrl,
      SITE_URL: 'https://zw.test',
    },
  });

  const run = await runWorkerOnce();
  assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('issue #43：过期条目的状态必须当场改口', () => {
  it('抓取后：进行中的条目带「征求意见中」徽标与倒计时', async () => {
    const items = listItems(await fetchHome());
    const soon = items.filter((item) => remainingDays(item) !== null);
    assert.ok(soon.length >= 2, `列表应有带倒计时的条目，实际 ${soon.length}`);
    for (const item of soon) {
      assert.equal(item.badge, '征求意见中', `「${item.title}」抓取后应是进行中`);
    }
  });

  /**
   * 倒计时的紧迫度分档（2026-10-07）：**渲染层**的证据。
   *
   * 判据与分档住在 `src/lib/notice-countdown.ts`，它的两层边界由
   * `tests/unit/countdown-urgency.test.mjs` 的真值表钉住。这里只证一件事：
   * 那个判据**真的到了页面上** —— 每条倒计时的类名与它自己那句文案的天数同档。
   *
   * 为什么必须从**渲染出来的天数**反推期望档位、而不是写死某一档：fixture 的截止日期
   * 是相对"抓取那一刻"生成的，写死档位会在某些日子假红。所以这里把页面上的文案翻译回
   * 天数，再按与判据相同的分档规则算期望类名 —— 测的是"文案与类名一致"这件事实。
   */
  it('倒计时的类名与它自己的天数同档（0–1 最强 / 2–3 中间 / ≥4 不醒目）', async () => {
    const items = listItems(await fetchHome());
    const withCountdown = items.filter((item) => item.countdown !== null);
    assert.ok(withCountdown.length >= 2, `列表应有带倒计时的条目，实际 ${withCountdown.length}`);

    for (const item of withCountdown) {
      const days = remainingDays(item);
      assert.ok(days !== null, `倒计时文案应是「今天截止 / 明天截止 / 剩 N 天」，实际 ${item.countdown}`);
      const expected = days <= 1 ? 'countdown countdown-urgent' : days <= 3 ? 'countdown countdown-soon' : 'countdown';
      assert.equal(
        item.countdownClass,
        expected,
        `「${item.title}」${item.countdown} 应挂 ${expected}，实际 ${item.countdownClass}`,
      );
    }

    // 反向：不展示倒计时的条目不许留下类名（组件返回 null，不是空 span）
    for (const item of items.filter((entry) => entry.countdown === null)) {
      assert.equal(item.countdownClass, null, `「${item.title}」没有倒计时就不该有那个 span`);
    }
  });

  it('同一张卡片上两个口径不分家：有倒计时的条目徽标必是「征求意见中」', async () => {
    // 判据同源（effectiveStatus）之后，这一条在两个口径分家时会立刻红 ——
    // 而分家的表现是"徽标已截止、倒计时还在"（每天 00:00 到下一轮抓取之间约 14 小时）。
    for (const item of listItems(await fetchHome())) {
      if (item.countdown === null) continue;
      assert.equal(item.badge, '征求意见中', `「${item.title}」有倒计时却不是进行中 —— 两个口径分家了`);
    }
  });

  it('时钟拨过截止日：徽标改口「已截止」、倒计时不再静默消失，未到期的条目不受影响', async (t) => {
    const before = listItems(await fetchHome());
    const dated = before
      .map((item) => ({ item, days: remainingDays(item) }))
      .filter((entry) => entry.days !== null)
      .sort((a, b) => a.days - b.days);
    const expiringSoon = dated[0]; // 最快到期的那条
    const stillFar = dated[dated.length - 1]; // 最远到期的那条
    assert.ok(
      stillFar.days > expiringSoon.days + 2,
      `fixture 需要「近/远」两个档期，实际 ${expiringSoon.days} 与 ${stillFar.days}`,
    );

    // 拨到「最快到期那条」的截止日之后一天
    const jumpDays = expiringSoon.days + 1;
    const shiftedMs = Date.now() + jumpDays * DAY_MS;
    t.mock.timers.enable({ apis: ['Date'] });
    try {
      t.mock.timers.setTime(shiftedMs);

      const after = listItems(await fetchHome());
      const flipped = after.find((item) => item.href === expiringSoon.item.href);
      const untouched = after.find((item) => item.href === stillFar.item.href);
      assert.ok(flipped && untouched, '两个条目都应仍在列表里');

      assert.equal(flipped.badge, '已截止', '过了截止日就必须改口，不能沿用库内状态');
      assert.equal(flipped.countdown, null, '已截止条目不再显示倒计时');
      assert.equal(
        untouched.badge,
        '征求意见中',
        `未到期（还剩 ${stillFar.days} 天）的条目不能被误伤`,
      );
      assert.ok(untouched.countdown !== null, '未到期条目照常显示倒计时');

      // 详情页与结构化数据同一口径
      const detail = stripSsrComments(await (await fetch(`${app.url}${flipped.href}`)).text());
      assert.match(
        detail,
        /data-testid="notice-status-badge"[^>]*>已截止</,
        '详情页徽标应同为已截止',
      );
      const jsonLd = JSON.parse(
        /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/.exec(detail)[1],
      );
      assert.equal(jsonLd.creativeWorkStatus, '已截止', '结构化数据不能与页面徽标矛盾');
      assert.match(
        /<meta name="description" content="([^"]*)"/.exec(detail)?.[1] ?? '',
        /^已截止/,
        '分享摘要同样要改口（摘要会被转发出去，没人会回来纠正）',
      );
    } finally {
      t.mock.timers.reset();
    }
  });
});
