import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { startAppServer } from './helpers/app-server.mjs';
import { upsertSubscriptionRules } from '../../src/db/repo/subscriptions.ts';

/**
 * E2E（issue #52）：并发重复提交订阅不得让公开端点 500 / 不得重复建行。
 *
 * 背景：`upsertSubscriptionRules` 是「先 select 再 insert」—— 两个调用同时提交同一个
 * **新**邮箱时都会走到 insert，后到者撞 `subscriptions_email_unique`。捕获异常没用
 * （唯一约束冲突的报错形状在 PG / SQLite 里不同，按方言分支会多出第二处方言代码，
 * ADR-0001 只允许 `periodDaysExpr` 那一处），所以改用 `ON CONFLICT DO NOTHING`：
 * 落空即说明另一个请求刚建了行，回落到更新分支。
 *
 * **为什么竞态用直接调用仓储来复现，而不是并发发 HTTP**：better-sqlite3 是同步驱动，
 * 一个请求处理器从 select 到 insert 全在微任务里跑完，事件循环根本轮不到处理下一个
 * 连接 —— HTTP 层在 SQLite 上**天然串行**，并发 POST 五次只会得到五次「先查后插」的
 * 顺序执行（本文件第一段就是这个事实的守卫，它证明不了竞态，但能挡住其它 500 来源）。
 * 直接 `Promise.all` 调用仓储函数则确定性复现：两个调用都在第一个 await 处让出，
 * 于是两次 select 都返回「不存在」，insert 才会撞上唯一约束 —— 正是线上（PG，真异步）
 * 双击 / 重试 / 扫描器造成的形态。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue52-race-'));
const dbFile = path.join(workDir, 'app.db');
const outboxFile = path.join(workDir, 'outbox.jsonl');

const EMAIL = 'race@example.com';
const CONCURRENCY = 5;

let app;

function postSubscription() {
  return fetch(`${app.url}/api/subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: EMAIL, keywords: '噪声污染防治' }),
    redirect: 'manual',
  });
}

/** 只读打开库数订阅行（应用同时持有写连接，SQLite 允许并发读）。 */
function countSubscriptions(email = EMAIL) {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db.prepare('select count(*) as n from subscriptions where email = ?').get(email).n;
  } finally {
    db.close();
  }
}

before(async () => {
  // 起应用：一是跑迁移建表（仓储函数需要 subscriptions 表），二是提供 HTTP 层断言
  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      MAILER_OUTBOX_FILE: outboxFile,
      SITE_URL: 'https://zw.test',
      APP_BASE_URL: 'https://zw.test',
      SUBSCRIBE_RATE_LIMIT_PER_HOUR: '100',
    },
  });
});

after(async () => {
  await app?.stop();
});

describe('issue #52：并发重复提交订阅', () => {
  it('HTTP 层并发提交同一新邮箱：全部 303（无 500），且只建一行', async () => {
    const responses = await Promise.all(Array.from({ length: CONCURRENCY }, () => postSubscription()));

    for (const [index, response] of responses.entries()) {
      assert.equal(
        response.status,
        303,
        `第 ${index + 1} 个并发请求应 303（撞唯一约束不能变成 500），实际 ${response.status}`,
      );
      assert.match(response.headers.get('location') ?? '', /sent=1/);
    }
    assert.equal(countSubscriptions(), 1, '并发提交同一邮箱只应建一行');
  });

  it('仓储层并发 upsert 同一新邮箱：不抛错、只建一行、且恰好一次 created', async () => {
    const email = 'race-repo@example.com';
    const input = { email, keywords: ['噪声污染防治'], categories: [], now: new Date() };

    // 关键：并发调用（不是并发 HTTP）。两个调用都会在第一个 await 处让出，
    // 两次 select 都看到「不存在」→ 两个都走 insert → 后到者撞唯一约束
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => upsertSubscriptionRules(input)),
    );

    const outcomes = results.map((result) => result.outcome);
    assert.equal(
      outcomes.filter((outcome) => outcome === 'created').length,
      1,
      `应恰好一次 created（其余走冲突回落），实际：${JSON.stringify(outcomes)}`,
    );
    assert.ok(
      outcomes.every((outcome) => outcome === 'created' || outcome === 'pending-refreshed'),
      `冲突回落应走「待确认刷新」分支，实际：${JSON.stringify(outcomes)}`,
    );
    assert.equal(countSubscriptions(email), 1, '并发 upsert 同一邮箱只应建一行');
    assert.ok(
      results.every((result) => result.subscription.email === email),
      '每个调用都应拿回同一个订阅行',
    );
  });
});
