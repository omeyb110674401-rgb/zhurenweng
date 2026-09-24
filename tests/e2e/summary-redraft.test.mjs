import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';

/**
 * 仓储层（issue #67）：存量摘要置换前的备份 + 清空。
 *
 * 为什么单独测这个函数而不是只测脚本：脚本可以有很多判据，但**"旧值必须在清空之前被拿到"**
 * 这一条是它唯一不能错的地方 —— 清空是单向的，返回顺序错了就等于把用户的摘要弄丢。
 * 这里直调函数（源码执行），所以撤掉实现会红；页面/脚本那一层跑的是构建产物或另一套进程。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-issue67-'));
const dbFile = path.join(workDir, 'app.db');

const WITH_SUMMARY = '1'.repeat(32);
const ALSO_SUMMARY = '2'.repeat(32);
const NO_SUMMARY = '3'.repeat(32);
const KEPT = '4'.repeat(32);

let noticesRepo;
let summariesRepo;
let db;

function summaryJson(marker) {
  return JSON.stringify({ what: { text: `${marker}：这是旧摘要`, quote: null, source: null } });
}

function row(id) {
  const rowValue = db.prepare('select ai_summary_json, summary_model, summary_status from notices where id = ?').get(id);
  return rowValue;
}

before(async () => {
  process.env.DB_DRIVER = 'sqlite';
  process.env.DATABASE_URL = dbFile;
  process.env.LLM_PROVIDER = 'stub';
  process.env.MAILER_PROVIDER = 'stub';
  process.env.ATTACHMENT_TEXT = 'off';

  noticesRepo = await import('../../src/db/repo/notices.ts');
  summariesRepo = await import('../../src/db/repo/summaries.ts');
  const sourcesRepo = await import('../../src/db/repo/sources.ts');
  await sourcesRepo.registerSource({ id: 'e2e-redraft', name: '重跑测试源', adapterType: 'fixture' });

  for (const [id, name] of [
    [WITH_SUMMARY, '甲：将被置换'],
    [ALSO_SUMMARY, '乙：也将被置换'],
    [NO_SUMMARY, '丙：本来没摘要'],
    [KEPT, '丁：有摘要但不在名单里'],
  ]) {
    await noticesRepo.upsertNotice({
      id,
      sourceId: 'e2e-redraft',
      title: name,
      agency: '测试机关',
      url: `https://source.test/${id}.html`,
      publishedAt: new Date().toISOString().slice(0, 10),
      deadlineAt: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10),
      status: 'open',
      bodyText: '现向社会公开征求意见。',
      attachments: [],
      fetchedAt: new Date().toISOString(),
    });
  }

  db = new Database(dbFile);
  const setSummary = db.prepare(
    'update notices set ai_summary_json = ?, summary_model = ?, summary_status = ? where id = ?',
  );
  for (const id of [WITH_SUMMARY, ALSO_SUMMARY, KEPT]) {
    setSummary.run(summaryJson(id.slice(0, 4)), 'mimo-v2.5', 'done', id);
  }
  // 连接留到 after() 再关：下面几个用例要直接读库核对"改了什么、没改什么"
});

after(() => {
  db.close();
  // 临时库文件留给系统清：Windows 上连接释放前 rmSync 会 EPERM
});

describe('issue #67：clearSummaryForRedraft', () => {
  it('返回的是清空**之前**的旧值（备份唯一的来源）', async () => {
    const before = await summariesRepo.clearSummaryForRedraft([WITH_SUMMARY, ALSO_SUMMARY]);
    const byId = new Map(before.map((item) => [item.id, item]));
    assert.equal(byId.size, 2, '两条都该拿到旧值');
    for (const id of [WITH_SUMMARY, ALSO_SUMMARY]) {
      const previous = byId.get(id);
      assert.ok(previous.previousSummaryJson.includes(id.slice(0, 4)), '旧摘要内容要原样返回');
      assert.equal(previous.previousModel, 'mimo-v2.5', '模型名也一起留着（恢复时要对得上）');
    }
  });

  it('清完是"空摘要 + pending"，摘要任务下一轮才会拾起它', () => {
    // 三个字段一起才算"回到队列里"：少了 summary_status='pending'，
    // 入队过滤（ai_summary_json IS NULL AND summary_status='pending'）仍然不认它
    for (const id of [WITH_SUMMARY, ALSO_SUMMARY]) {
      const value = row(id);
      assert.equal(value.ai_summary_json, null);
      assert.equal(value.summary_model, null);
      assert.equal(value.summary_status, 'pending');
    }
  });

  it('名单外的条目一个字不动（包括同样有摘要的丁）', () => {
    const kept = row(KEPT);
    assert.ok(kept.ai_summary_json.includes(KEPT.slice(0, 4)), '丁的摘要必须还在');
    assert.equal(kept.summary_status, 'done');
    assert.ok(row(NO_SUMMARY).ai_summary_json === null, '丙本来就没有摘要，不该被牵连');
  });

  it('空名单直接返回空、不发语句', async () => {
    // 这条**不钉**函数里那句 `if (ids.length === 0) return []`：撤掉它这条仍然绿 ——
    // drizzle 把空的 `inArray` 编成恒假条件而不是非法 SQL。留那道保护是为了不依赖驱动
    // 怎么编空集合，而不是因为它有可观测行为（对应的 pin 位因此被删，见 check-test-pins.mjs）
    assert.deepEqual(await summariesRepo.clearSummaryForRedraft([]), []);
    assert.equal(row(KEPT).ai_summary_json.includes('4444'), true);
  });
});
