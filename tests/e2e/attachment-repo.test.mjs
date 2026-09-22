import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * 仓库层（issue #57）：`notice_attachments` 的状态跨轮语义。
 *
 * 这一层存在的理由是「附件清单每轮被 `attachments_json` 整体覆盖」，所以抽取状态
 * 必须按 (notice_id, url) 存活下来。下面每条断言都在钉这个不变式：
 * 同步清单不覆盖结论、清单里消失的 URL 删行、终态不重复消耗请求、
 * 只有真的发过请求才推进退避窗口。
 *
 * 零外部依赖（ADR-0001）：临时 SQLite 文件库，不起 web。
 */

const workDir = mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-attachments-repo-'));
const dbFile = path.join(workDir, 'app.db');

const NOTICE_ID = 'a'.repeat(32);
const CLOSED_NOTICE_ID = 'b'.repeat(32);
const URL_DRAFT = 'https://example.gov.cn/files/draft.pdf';
const URL_FORM = 'https://example.gov.cn/files/form.docx';
const NOW = new Date('2026-09-22T08:00:00.000Z');

const iso = (date) => date.toISOString();

let repo;
let notices;
let sources;

function ago(days) {
  return new Date(NOW.getTime() - days * 86_400_000);
}
function daysAgo(days) {
  return iso(ago(days));
}
before(async () => {
  process.env.DB_DRIVER = 'sqlite';
  process.env.DATABASE_URL = dbFile;
  // 客户端是进程内单例，首次 getDb() 才建连接并跑迁移 —— 必须等 env 就位后再动态引入
  repo = await import('../../src/db/repo/attachments.ts');
  notices = await import('../../src/db/repo/notices.ts');
  sources = await import('../../src/db/repo/sources.ts');

  await sources.upsertSource({
    id: 'moj',
    name: '司法部',
    adapterType: 'moj',
    healthy: true,
    lastSuccessAt: iso(NOW),
  });
  for (const [id, status] of [
    [NOTICE_ID, 'open'],
    [CLOSED_NOTICE_ID, 'closed'],
  ]) {
    await notices.upsertNotice({
      id,
      sourceId: 'moj',
      title: `测试条目 ${id}`,
      agency: '司法部',
      url: `https://example.gov.cn/detail-${id}.html`,
      publishedAt: daysAgo(3),
      deadlineAt: daysAgo(-10),
      status,
      categoryTags: ['立法与司法'],
      bodyText: '正文壳',
      attachments: [
        { name: '草案.pdf', url: URL_DRAFT },
        { name: '意见反馈表.docx', url: URL_FORM },
      ],
      fetchedAt: daysAgo(1),
    });
  }
});


/** 读回某条目的全部附件行，按 URL 排序，便于稳定断言。 */
async function rowsOf(noticeId) {
  const all = await repo.listEligibleAttachments(noticeId, {
    now: new Date('2100-01-01T00:00:00.000Z'),
    blockedRetryAfterDays: 0,
    maxAttempts: 999,
    refreshAfterDays: 0,
  });
  return all.sort((a, b) => (a.url < b.url ? -1 : 1));
}

describe('syncAttachmentManifest：清单同步不覆盖结论', () => {
  it('首轮把清单里的每个 URL 落成 pending', async () => {
    await repo.syncAttachmentManifest({ noticeId: NOTICE_ID, attachments: [], now: NOW });
    await repo.syncAttachmentManifest({
      noticeId: NOTICE_ID,
      attachments: [
        { name: '草案.pdf', url: URL_DRAFT },
        { name: '意见反馈表.docx', url: URL_FORM },
      ],
      now: NOW,
    });

    const rows = await rowsOf(NOTICE_ID);
    assert.deepEqual(
      rows.map((row) => [row.url, row.status, row.firstSeenAt, row.lastSeenAt]),
      [
        [URL_DRAFT, 'pending', iso(NOW), iso(NOW)],
        [URL_FORM, 'pending', iso(NOW), iso(NOW)],
      ],
    );
  });

  it('同一 URL 再来一轮：只刷新名称与 last_seen_at，结论与 first_seen_at 保持', async () => {
    await repo.markAttachmentResult(NOTICE_ID, URL_DRAFT, {
      status: 'ok',
      kind: 'pdf',
      charCount: 50_000,
      contentHash: 'hash-draft',
      extractedText: '第一条 …',
      fetchedAt: NOW,
    });

    const later = new Date(NOW.getTime() + 86_400_000);
    await repo.syncAttachmentManifest({
      noticeId: NOTICE_ID,
      attachments: [{ name: '草案（修订稿）.pdf', url: URL_DRAFT }],
      now: later,
    });

    const [row] = (await rowsOf(NOTICE_ID)).filter((item) => item.url === URL_DRAFT);
    assert.equal(row.status, 'ok', '同步清单不得把上一轮结论打回 pending');
    assert.equal(row.name, '草案（修订稿）.pdf', '展示名每轮跟随官方');
    assert.equal(row.firstSeenAt, iso(NOW), '首次见到时间不被覆盖');
    assert.equal(row.lastSeenAt, iso(later));
    assert.equal(row.contentHash, 'hash-draft');
  });

  it('清单里消失的 URL 删行；URL 重复只留一行', async () => {
    await repo.syncAttachmentManifest({
      noticeId: NOTICE_ID,
      attachments: [
        { name: '草案.pdf', url: URL_DRAFT },
        { name: '草案（重复链接）.pdf', url: URL_DRAFT },
      ],
      now: NOW,
    });

    const rows = await rowsOf(NOTICE_ID);
    assert.deepEqual(
      rows.map((row) => row.url),
      [URL_DRAFT],
      '官方撤下的附件不留孤儿状态，重复 URL 不产生两行',
    );
  });
});

describe('listEligibleAttachments：终态不再消耗请求', () => {
  const eligibility = {
    now: NOW,
    blockedRetryAfterDays: 7,
    maxAttempts: 3,
    refreshAfterDays: 14,
  };

  async function seed(url, patch) {
    await repo.syncAttachmentManifest({
      noticeId: NOTICE_ID,
      attachments: [{ name: 'x', url }],
      now: NOW,
    });
    await repo.markAttachmentResult(NOTICE_ID, url, patch);
  }

  it('pending 总是可处理', async () => {
    await repo.syncAttachmentManifest({
      noticeId: NOTICE_ID,
      attachments: [{ name: '新附件.pdf', url: 'https://example.gov.cn/files/new.pdf' }],
      now: NOW,
    });
    const urls = (await repo.listEligibleAttachments(NOTICE_ID, eligibility)).map((r) => r.url);
    assert.ok(urls.includes('https://example.gov.cn/files/new.pdf'));
  });

  it('blocked 按 7 天退避；没发过请求的立刻可试', async () => {
    await seed('https://example.gov.cn/blocked-recent.pdf', {
      status: 'blocked',
      error: 'HTTP 403',
      fetchedAt: ago(1),
    });
    await seed('https://example.gov.cn/blocked-old.pdf', {
      status: 'blocked',
      error: 'HTTP 403',
      fetchedAt: ago(8),
    });

    const urls = (await repo.listEligibleAttachments(NOTICE_ID, eligibility)).map((r) => r.url);
    assert.ok(!urls.includes('https://example.gov.cn/blocked-recent.pdf'), '退避窗口内不再敲源站');
    assert.ok(urls.includes('https://example.gov.cn/blocked-old.pdf'), '超过窗口允许再探一次');
  });

  it('error 受尝试次数上限约束，ok 按刷新周期重取', async () => {
    await seed('https://example.gov.cn/error-max.pdf', {
      status: 'error',
      error: 'boom',
      fetchedAt: ago(1),
    });
    await seed('https://example.gov.cn/error-max.pdf', {
      status: 'error',
      error: 'boom',
      fetchedAt: ago(1),
    });
    await seed('https://example.gov.cn/error-max.pdf', {
      status: 'error',
      error: 'boom',
      fetchedAt: ago(1),
    });
    const exhausted = await repo.listEligibleAttachments(NOTICE_ID, eligibility);
    assert.ok(
      !(await exhausted.some((row) => row.url === 'https://example.gov.cn/error-max.pdf')),
      '三次尝试用尽后停在 error，不再无限重试',
    );

    await seed('https://example.gov.cn/ok-fresh.pdf', {
      status: 'ok',
      kind: 'pdf',
      charCount: 5000,
      fetchedAt: ago(3),
    });
    await seed('https://example.gov.cn/ok-stale.pdf', {
      status: 'ok',
      kind: 'pdf',
      charCount: 5000,
      fetchedAt: ago(20),
    });
    const urls = (await repo.listEligibleAttachments(NOTICE_ID, eligibility)).map((r) => r.url);
    assert.ok(!urls.includes('https://example.gov.cn/ok-fresh.pdf'), '刚取过的不重取');
    assert.ok(urls.includes('https://example.gov.cn/ok-stale.pdf'), '官方可能换稿，久了要重取');
  });

  it('空白表 / 扫描件 / 非文件 / 超限都是终态', async () => {
    for (const [url, status] of [
      ['https://example.gov.cn/t/blank.pdf', 'no_draft_text'],
      ['https://example.gov.cn/t/scan.pdf', 'scanned_no_text'],
      ['https://example.gov.cn/t/html.pdf', 'not_a_file'],
      ['https://example.gov.cn/t/huge.pdf', 'too_large'],
      ['https://example.gov.cn/t/ole.doc', 'unsupported_container'],
    ]) {
      await seed(url, { status, error: null, fetchedAt: ago(30) });
    }
    const urls = (await repo.listEligibleAttachments(NOTICE_ID, eligibility)).map((r) => r.url);
    for (const url of [
      'https://example.gov.cn/t/blank.pdf',
      'https://example.gov.cn/t/scan.pdf',
      'https://example.gov.cn/t/html.pdf',
      'https://example.gov.cn/t/huge.pdf',
      'https://example.gov.cn/t/ole.doc',
    ]) {
      assert.ok(!urls.includes(url), `${url} 是终态，不该再发请求`);
    }
  });
});

describe('markAttachmentResult：只有真发过请求才推进退避', () => {
  it('不带 fetchedAt 的写入保留上次时间与尝试次数', async () => {
    const url = 'https://example.gov.cn/skipped.pdf';
    await repo.syncAttachmentManifest({
      noticeId: NOTICE_ID,
      attachments: [{ name: 'x', url }],
      now: NOW,
    });
    await repo.markAttachmentResult(NOTICE_ID, url, {
      status: 'blocked',
      error: 'HTTP 403',
      fetchedAt: NOW,
    });
    const before = (await rowsOf(NOTICE_ID)).find((row) => row.url === url);
    assert.equal(before?.attemptCount, 1);

    await repo.markAttachmentResult(NOTICE_ID, url, {
      status: 'blocked',
      error: '本轮被熔断跳过',
    });
    const after = (await rowsOf(NOTICE_ID)).find((row) => row.url === url);
    assert.equal(after?.attemptCount, 1, '没发请求不该增加尝试次数');
    assert.equal(after?.lastFetchAt, iso(NOW), '退避窗口不被跳过轮次重置');
  });
});

describe('摘要输入与读侧报告', () => {
  it('只取 ok、够长的行，按字数降序并受 limit 约束', async () => {
    const targetId = 'c'.repeat(32);
    await notices.upsertNotice({
      id: targetId,
      sourceId: 'moj',
      title: '摘要输入用条目',
      agency: '司法部',
      url: 'https://example.gov.cn/detail-c.html',
      publishedAt: daysAgo(3),
      deadlineAt: daysAgo(-10),
      status: 'open',
      categoryTags: ['立法与司法'],
      bodyText: '壳',
      attachments: [],
      fetchedAt: daysAgo(1),
    });
    const big = 'https://example.gov.cn/c/big.pdf';
    const small = 'https://example.gov.cn/c/small.docx';
    const blank = 'https://example.gov.cn/c/blank.docx';
    const rejected = 'https://example.gov.cn/c/blocked.pdf';
    await repo.syncAttachmentManifest({
      noticeId: targetId,
      attachments: [
        { name: '大附件', url: big },
        { name: '小附件', url: small },
        { name: '空白表', url: blank },
        { name: '被拒', url: rejected },
      ],
      now: NOW,
    });
    await repo.markAttachmentResult(targetId, big, {
      status: 'ok',
      kind: 'pdf',
      charCount: 50_000,
      extractedText: '适用范围：本文件适用于…',
      fetchedAt: NOW,
    });
    await repo.markAttachmentResult(targetId, small, {
      status: 'ok',
      kind: 'docx',
      charCount: 3_000,
      extractedText: '第一条 …',
      fetchedAt: NOW,
    });
    await repo.markAttachmentResult(targetId, blank, {
      status: 'ok',
      kind: 'docx',
      charCount: 50,
      extractedText: '姓名____',
      fetchedAt: NOW,
    });
    await repo.markAttachmentResult(targetId, rejected, {
      status: 'blocked',
      error: 'HTTP 403',
      fetchedAt: NOW,
    });

    const picked = await repo.listAttachmentsForSummary(targetId, { minChars: 400, limit: 2 });
    assert.deepEqual(
      picked.map((item) => item.url),
      [big, small],
      '空白表被 minChars 挡掉，被拒的不在候选里',
    );
    assert.equal(picked[0].name, '大附件');

    await repo.markAttachmentsFedToSummary(targetId, [big, small]);
    const report = await repo.getNoticeAttachmentExtractReport(targetId);
    assert.equal(report.total, 4);
    assert.deepEqual(
      report.fed.map((item) => item.name),
      ['大附件', '小附件'],
    );
    assert.deepEqual(report.failures, { blocked: 1 }, '失败计数只给文案用，不含 ok / pending');
  });

  it('已截止条目不进工作队列', async () => {
    const list = await repo.listNoticesForAttachmentExtraction({ limit: 50 });
    assert.ok(!list.some((item) => item.id === CLOSED_NOTICE_ID));
    assert.ok(list.some((item) => item.id === NOTICE_ID));
  });

  it('sourceIds 灰度名单生效', async () => {
    const onlyMee = await repo.listNoticesForAttachmentExtraction({
      limit: 50,
      sourceIds: ['mee'],
    });
    assert.equal(onlyMee.length, 0);
  });
});
