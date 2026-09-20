import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startAppServer } from './helpers/app-server.mjs';
/**
 * E2E（issue #17）：邮件订阅入口的可用性门控。
 *
 * 背景：生产上线时 `MAILER_PROVIDER=smtp` 但 SMTP_* 未配置 —— 订阅表单必然提交
 * 失败（确认邮件发不出去）。此时对外展示订阅入口等于给用户一个死流程，因此
 * 入口可见性与表单可用性统一由「邮件端口是否配置齐全」决定
 * （src/lib/mailer-availability.ts）：
 *
 *   - 本文件：smtp 但缺 SMTP_HOST（= 当前生产状态）→ 首页不出现订阅入口、
 *     订阅页给不可用提示而非表单、POST 直接回 mailer_unavailable 且不写库；
 *   - 配置齐全（或 MAILER_PROVIDER=stub，见 deadline-reminders.test.mjs）
 *     → 入口出现、表单可用。
 *
 * 全程零外部依赖（ADR-0001）：SQLite 临时文件库 + 进程内生产模式应用。
 * 本文件不启动 fixture 源站 —— 门控只依赖环境变量，与抓取无关。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-subscribe-gate-'));
const dbFile = path.join(workDir, 'app.db');

/** 当前生产状态：smtp 端口但 SMTP_HOST 为空（compose 传的是 ${SMTP_HOST:-}） */
const UNAVAILABLE_ENV = {
  DATABASE_URL: dbFile,
  LLM_PROVIDER: 'stub',
  MAILER_PROVIDER: 'smtp',
  SMTP_HOST: '',
  MAIL_FROM: '',
};

let app;

before(async () => {
  app = await startAppServer({ env: UNAVAILABLE_ENV });
});

after(async () => {
  await app?.stop();
});

/** 订阅表行数（直连 SQLite 只读断言「未写库」）。 */
function subscriptionCount() {
  const db = new Database(dbFile, { readonly: true });
  try {
    const row = db.prepare('select count(*) as c from subscriptions').get();
    return Number(row.c);
  } finally {
    db.close();
  }
}

describe('issue #17：邮件端口未配置时的订阅入口门控', () => {
  it('首页不出现订阅入口（导航与列表头都无），RSS 与数据统计入口不受影响', async () => {
    const html = await (await fetch(`${app.url}/`)).text();

    assert.ok(!html.includes('subscribe-nav-link'), '导航不应出现订阅入口（会指向必然失败的流程）');
    assert.ok(!html.includes('subscribe-list-link'), '列表头不应出现邮件提醒入口');
    assert.ok(!html.includes('href="/subscribe"'), '首页不应有任何指向 /subscribe 的链接');

    // 不受门控影响的入口仍在
    assert.match(html, /data-testid="rss-feed-link"/, 'RSS 入口与邮件配置无关');
    assert.match(html, /data-testid="stats-nav-link"/, '数据统计入口与邮件配置无关');
  });

  it('订阅页给出不可用提示与 RSS 兜底，不渲染会失败的表单', async () => {
    const html = await (await fetch(`${app.url}/subscribe`)).text();

    assert.match(html, /data-testid="subscribe-unavailable-banner"/, '应有不可用提示横幅');
    assert.match(html, /邮件订阅暂未开放/, '提示应说明当前不可用');
    assert.match(html, /data-testid="subscribe-unavailable-rss"/, '应给出 RSS 兜底入口');
    assert.ok(!html.includes('subscribe-form'), '不应渲染订阅表单');
    assert.ok(!html.includes('subscribe-submit'), '不应渲染提交按钮');
    assert.ok(!html.includes('subscribe-email'), '不应渲染邮箱输入框');
  });

  it('直接 POST /api/subscriptions 被门控拦下：回 mailer_unavailable、不写库', async () => {
    const before = subscriptionCount();

    const form = new URLSearchParams({
      email: 'gate-check@example.com',
      keywords: '噪声污染防治',
    });
    const response = await fetch(`${app.url}/api/subscriptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    assert.equal(response.status, 303, '应 303 回订阅页');
    assert.equal(
      response.headers.get('location'),
      '/subscribe?error=mailer_unavailable',
      '错误码应为 mailer_unavailable（而不是走到发信才失败的 send_failed）',
    );

    assert.equal(subscriptionCount(), before, '被拦下的提交不应写入任何订阅行');

    const html = await (await fetch(`${app.url}/subscribe?error=mailer_unavailable`)).text();
    assert.match(html, /data-testid="subscribe-error-banner"/);
    assert.match(html, /邮件订阅暂未开放/);
  });
});
