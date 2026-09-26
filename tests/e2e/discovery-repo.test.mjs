import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';

/**
 * 仓储层（issue #62）：`listNoticesFiltered` 的排序与两个新筛选条件。
 *
 * 与 `discovery-controls.test.mjs` 的分工：那份走 HTTP，验的是「页面上说的顺序」与
 * 「用户看到的条目」一致；这份**直调仓储函数**。同一个判断只在一处被钉住是不够的 ——
 * 页面层跑的是 `.next` 构建产物，撤掉源码里的 SQL 实现它照样绿（`check-test-pins.mjs`
 * 头注的规则 1），所以排序与筛选的 SQL 实现必须由这份从源码执行的测试来钉。
 *
 * 丁 / 戊 / 丙 三行分别钉住三件容易写错的事：
 * - 丁：库里 `status='open'` 但截止日已过 → **既**要被「只看未截止」按展示口径排掉（issue #62），
 *   **也**不能被默认排序当成"还能提意见"摆上头屏（issue #79：生产实测头屏 9 条已截止）。
 *   这两件事必须一起钉：只修筛选不改排序的话，首页第一屏仍然是一堆提不了意见的条目；
 * - 戊：`first_seen_at` 为 NULL（迁移 0013 之前的存量）→ 「最近新增」不能把它算进来；
 * - 丙：**今天被重新抓过**（`fetched_at` = 现在）但 40 天前就收录了 → 判据用错列
 *   （拿 `fetched_at` 当"什么时候进来的"）时，这条会天天被当成新增。线上 178 条条目
 *   每天都会被覆盖一次 `fetched_at`，用错列等于全库都是"新"。
 *
 * 零外部依赖（ADR-0001）：临时 SQLite 文件库。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-issue62-repo-'));
const dbFile = path.join(workDir, 'app.db');

const A = { id: 'a'.repeat(32), title: '发现层甲：新收录晚截止' };
const B = { id: 'b'.repeat(32), title: '发现层乙：最新发布' };
const C = { id: 'c'.repeat(32), title: '发现层丙：已截止但今天被重抓' };
const D = { id: 'd'.repeat(32), title: '发现层丁：库里未改口的过期条目' };
const E = { id: 'e'.repeat(32), title: '发现层戊：存量无收录时间' };

let noticesRepo;
let db;

function stampPlusDays(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function datePlusDays(days) {
  return stampPlusDays(days).slice(0, 10);
}

/** 查询 → 「丁乙甲戊丙」这样的顺序串（比对排序时比读整条标题省事）。 */
const MARK = new Map([
  [A.id, '甲'],
  [B.id, '乙'],
  [C.id, '丙'],
  [D.id, '丁'],
  [E.id, '戊'],
]);

function marks(rows) {
  return rows.map((row) => MARK.get(row.id) ?? '?').join('');
}

/** 期望顺序写成条目清单，读的人不用记字母表。 */
function inOrder(...notices) {
  return notices.map((notice) => MARK.get(notice.id)).join('');
}

before(async () => {
  process.env.DB_DRIVER = 'sqlite';
  process.env.DATABASE_URL = dbFile;
  process.env.LLM_PROVIDER = 'stub';
  process.env.MAILER_PROVIDER = 'stub';

  noticesRepo = await import('../../src/db/repo/notices.ts');
  const sourcesRepo = await import('../../src/db/repo/sources.ts');
  await sourcesRepo.registerSource({ id: 'e2e-discovery-repo', name: '发现层仓储测试源', adapterType: 'fixture' });

  const seed = async (notice, { publishedPlusDays, deadlinePlusDays, seenPlusDays, status }) => {
    await noticesRepo.upsertNotice({
      id: notice.id,
      sourceId: 'e2e-discovery-repo',
      title: notice.title,
      agency: '测试机关',
      url: `https://source.test/${notice.id}.html`,
      publishedAt: datePlusDays(publishedPlusDays),
      deadlineAt: datePlusDays(deadlinePlusDays),
      status,
      bodyText: '现向社会公开征求意见。',
      attachments: [],
      fetchedAt: stampPlusDays(seenPlusDays),
    });
  };
  await seed(A, { publishedPlusDays: -200, deadlinePlusDays: 30, seenPlusDays: -2, status: 'open' });
  await seed(B, { publishedPlusDays: -35, deadlinePlusDays: 2, seenPlusDays: -20, status: 'open' });
  await seed(C, { publishedPlusDays: -80, deadlinePlusDays: -10, seenPlusDays: -40, status: 'closed' });
  await seed(D, { publishedPlusDays: -110, deadlinePlusDays: -1, seenPlusDays: -5, status: 'open' });
  await seed(E, { publishedPlusDays: -190, deadlinePlusDays: 60, seenPlusDays: -100, status: 'open' });

  db = new Database(dbFile);
  db.prepare('UPDATE notices SET outbound_clicks = 3 WHERE id = ?').run(A.id);
  db.prepare('UPDATE notices SET outbound_clicks = 50 WHERE id = ?').run(C.id);
  db.prepare('UPDATE notices SET outbound_clicks = 9 WHERE id = ?').run(E.id);
  db.prepare('UPDATE notices SET first_seen_at = NULL WHERE id = ?').run(E.id);
  // 丙：每天被抓取覆盖 —— 它的 fetched_at 是"刚刚"，而它 40 天前就进库了
  db.prepare('UPDATE notices SET fetched_at = ? WHERE id = ?').run(stampPlusDays(0), C.id);
  db.close();
});

after(() => {
  // 临时库文件留给系统清：Windows 上仓储层的连接释放前 rmSync 会 EPERM
});

describe('issue #62 仓储层：排序档位', () => {
  it('不传 sort 档 = 还能提意见的在前（按展示口径判）、再按截止日期升序；`deadline` 档与它一字不差', async () => {
    const plain = marks(await noticesRepo.listNoticesFiltered({}));
    // 乙(+2) 甲(+30) 戊(+60) 是还能提意见的；丙(已截止) 丁(库里还写 open、截止日已过) 沉底。
    // 丁的位置就是 issue #79 的修复点：它曾经凭库列 status 排在最前（截止日 -1 天最早）。
    assert.equal(plain, inOrder(B, A, E, C, D));
    assert.equal(marks(await noticesRepo.listNoticesFiltered({ sort: 'deadline' })), plain);
  });

  it('`published` / `newest` / `clicks` 三档各自换掉了顺序（不是换个参数名走同一条 SQL）', async () => {
    assert.equal(marks(await noticesRepo.listNoticesFiltered({ sort: 'published' })), inOrder(B, C, D, E, A));
    assert.equal(marks(await noticesRepo.listNoticesFiltered({ sort: 'newest' })), inOrder(A, D, B, C, E));
    // 甲乙并列 0 点击，尾键仍走同一份聚合序 ⇒ 还能提意见的甲在已截止的乙前
    assert.equal(marks(await noticesRepo.listNoticesFiltered({ sort: 'clicks' })), inOrder(C, E, A, B, D));
  });

  it('每一档翻页翻完 = 全集且不重复（末位 `asc(id)` 尾键；并列行不得被 LIMIT/OFFSET 拆乱）', async () => {
    const seen = new Set();
    for (const sort of ['deadline', 'published', 'newest', 'clicks']) {
      const walked = [];
      for (let offset = 0; offset < 10; offset += 2) {
        const rows = await noticesRepo.listNoticesFiltered({ sort, limit: 2, offset });
        walked.push(...rows.map((row) => row.id));
      }
      assert.equal(new Set(walked).size, 5, `${sort} 档翻完出现重复行：${walked.join(',')}`);
      assert.equal(walked.length, 5, `${sort} 档翻完漏行`);
      for (const id of walked) seen.add(id);
    }
    assert.equal(seen.size, 5, '四档合起来应覆盖全部条目');
  });
});

describe('issue #62 仓储层：只看未截止与最近新增', () => {
  it('openOnly 用展示口径：库里 status 还写 open、但截止日已过的条目要排掉', async () => {
    const rows = await noticesRepo.listNoticesFiltered({ openOnly: true });
    assert.equal(marks(rows), inOrder(B, A, E));
    assert.ok(!rows.some((row) => row.id === D.id), '丁的截止日已过，不该在未截止视图里');
  });

  it('firstSeenWithinDays 用 first_seen_at，不是每天覆盖的 fetched_at', async () => {
    const rows = await noticesRepo.listNoticesFiltered({ firstSeenWithinDays: 30 });
    // 顺序仍走默认档（还能提意见的在前）：乙(+2) 甲(+30) 在前，丁已过期沉底
    assert.equal(marks(rows), inOrder(B, A, D));
    // 丙今天被重抓过（fetched_at = 现在），但它 40 天前就进库了：按 fetched_at 判它会被算成新增
    assert.ok(!rows.some((row) => row.id === C.id), '丙是 40 天前收录的老条目，重抓不算新增');
    assert.ok(!rows.some((row) => row.id === E.id), '戊没有收录时间（NULL），不能算新增');
  });

  it('两个条件可与既有维度叠加，且 count 与 list 同口径（「共 N 条」不能骗人）', async () => {
    for (const options of [
      { openOnly: true },
      { firstSeenWithinDays: 7 },
      { openOnly: true, firstSeenWithinDays: 30 },
      { openOnly: true, keyword: '征求意见' },
      { openOnly: true, agency: '测试机关' },
    ]) {
      const [rows, count] = await Promise.all([
        noticesRepo.listNoticesFiltered(options),
        noticesRepo.countNoticesFiltered(options),
      ]);
      assert.equal(count, rows.length, `条件 ${JSON.stringify(options)} 下计数与列表不一致`);
    }
  });

  it('两个条件同时开时取交集（未截止 ∩ 近 7 天 = 只有甲）', async () => {
    const rows = await noticesRepo.listNoticesFiltered({ openOnly: true, firstSeenWithinDays: 7 });
    assert.equal(marks(rows), inOrder(A));
  });
});
