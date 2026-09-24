// 迁移目录完整性守卫：代码按 drizzle/<driver> 解析迁移目录（src/db/client.ts 的
// migrationsFolder），本测试确保两个方言目录都存在、journal 与 SQL 文件一一对应。
// 背景：曾发生 drizzle/pg 与驱动名 postgres 不一致，导致生产容器启动即崩，
// 而本地 E2E 只用 SQLite 未覆盖——此守卫专门防止该类回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

for (const driver of ['sqlite', 'postgres']) {
  test(`迁移目录 drizzle/${driver} 与 journal 自洽`, () => {
    const dir = path.join(root, 'drizzle', driver);
    assert.ok(fs.existsSync(dir), `缺少迁移目录 drizzle/${driver}（代码按驱动名解析：migrationsFolder('${driver}')）`);

    const journalPath = path.join(dir, 'meta', '_journal.json');
    assert.ok(fs.existsSync(journalPath), `缺少 ${path.relative(root, journalPath)}`);

    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    const tags = journal.entries.map((e) => e.tag);
    assert.ok(tags.length > 0, 'journal 不应为空');

    // idx 连续且从 0 开始
    journal.entries.forEach((entry, i) => {
      assert.equal(entry.idx, i, `journal idx 不连续：第 ${i} 项 idx=${entry.idx}`);
    });

    // 每个 journal 条目必须有对应 SQL 文件
    for (const tag of tags) {
      const sqlPath = path.join(dir, `${tag}.sql`);
      assert.ok(fs.existsSync(sqlPath), `journal 条目 ${tag} 缺少对应文件 ${path.relative(root, sqlPath)}`);
    }
  });
}

/**
 * 两方言的迁移序号与建表列集合必须一致（issue #57 起加强）。
 *
 * 背景：`src/db/schema/{sqlite,postgres}.ts` 互为镜像是全项目的约定，但此前没有任何
 * 机器检查 —— 只给一个方言加迁移，另一方言的库就会少一列，而 SQLite 跑的所有测试
 * 都不会发现（生产用的是 PostgreSQL）。`notice_attachments` 是第一次加 15 列的表，
 * 这种漂移的代价最高。
 *
 * 两条断言：① 迁移**序号**序列一致（drizzle-kit 生成的 0000/0001 两方言随机名不同，
 * 所以按序号而不是按 tag 比）；② 对手工书写、两方言同名的迁移，CREATE TABLE 的列集合一致。
 */
function columnNamesOf(sqlText) {
  const names = new Set();
  for (const line of sqlText.split('\n')) {
    // 只认列定义行（`col` text / "col" integer）；PRIMARY KEY / CONSTRAINT /
    // FOREIGN KEY / CREATE INDEX 这些行都以关键字开头，天然被排除
    const match = /^\s*[`"]([a-z0-9_]+)[`"]\s+(text|integer)\b/i.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

function tagsOf(driver) {
  const journalPath = path.join(root, 'drizzle', driver, 'meta', '_journal.json');
  return JSON.parse(fs.readFileSync(journalPath, 'utf8')).entries.map((entry) => entry.tag);
}

const sqliteTags = tagsOf('sqlite');
const postgresTags = tagsOf('postgres');

test('两方言的迁移序号一致（缺一边就是生产少列）', () => {
  const numbersOf = (tags) => tags.map((tag) => tag.slice(0, 4));
  assert.deepEqual(numbersOf(postgresTags), numbersOf(sqliteTags));
});

test('两方言同名迁移的建表列集合一致', () => {
  for (const tag of sqliteTags) {
    if (!postgresTags.includes(tag)) continue; // drizzle-kit 随机命名的生成迁移不比列
    const sqliteSql = fs.readFileSync(path.join(root, 'drizzle/sqlite', `${tag}.sql`), 'utf8');
    const postgresSql = fs.readFileSync(
      path.join(root, 'drizzle/postgres', `${tag}.sql`),
      'utf8',
    );
    const sqliteColumns = columnNamesOf(sqliteSql);
    const postgresColumns = columnNamesOf(postgresSql);
    if (sqliteColumns.size === 0 && postgresColumns.size === 0) continue;
    assert.deepEqual(
      [...postgresColumns].sort(),
      [...sqliteColumns].sort(),
      `${tag}：两方言的列集合不一致`,
    );
  }
});

/**
 * journal 的 `when` 必须严格递增 —— 2026-09-24 生产事故的守卫。
 *
 * drizzle 的迁移器对**存量库**只执行 `when` 晚于「最后一条已应用记录」的迁移
 * （`if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis)`）。
 * 手工补迁移时我给 0012–0014 写了 `17900000000xx`，比 0011 的 `1791072003000` **更早**，
 * 于是这三条在生产上被**静默跳过**：文件在、journal 里在、`db-migrate` 还打印
 * 「迁移已应用」，退出码 0。结果是跑着新代码的容器读不到 `first_seen_at` /
 * `scope` / `notice_notifications`。
 *
 * 为什么本地全绿也照样出事：全新库的 `__drizzle_migrations` 是空的，
 * `!lastDbMigration` 对每一条都成立 ⇒ 一次全跑，**永远看不到跳过**。
 * 只有「存量库向后迁移」这条路径才暴露它，而那条路径只有生产走。
 * 所以这里既钉结构（下面的单调性），也钉行为（再下面那段两阶段迁移）。
 */
function journalOf(driver) {
  const journalPath = path.join(root, 'drizzle', driver, 'meta', '_journal.json');
  return JSON.parse(fs.readFileSync(journalPath, 'utf8')).entries;
}

for (const driver of ['sqlite', 'postgres']) {
  test(`journal 的 when 严格递增（${driver}）`, () => {
    const entries = journalOf(driver);
    for (let i = 1; i < entries.length; i += 1) {
      assert.ok(
        entries[i].when > entries[i - 1].when,
        `${driver} 第 ${i} 项 ${entries[i].tag} 的 when=${entries[i].when} 不早于前一项 ` +
          `${entries[i - 1].tag}(${entries[i - 1].when})：drizzle 会静默跳过它，存量库永远不会拿到这条迁移`,
      );
    }
  });
}

/** 复制迁移目录，可只保留前 N 项（构造"某个存量库当时的样子"）。 */
function copyFolder(targetDir, maxIdx) {
  fs.cpSync(path.join(root, 'drizzle/sqlite'), targetDir, { recursive: true });
  if (maxIdx === undefined) return targetDir;
  const journalPath = path.join(targetDir, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  journal.entries = journal.entries.filter((entry) => entry.idx <= maxIdx);
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  return targetDir;
}

test('存量库向后迁移会补上晚到的迁移（生产跳过 0012–0014 的形状）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-migrate-late-'));
  const dbFile = path.join(tmp, 'app.db');
  const columnsOf = (table) => {
    const sqlite = new Database(dbFile, { readonly: true });
    try {
      return new Set(sqlite.prepare(`pragma table_info(${table})`).all().map((row) => row.name));
    } finally {
      sqlite.close();
    }
  };
  const apply = (folder) => {
    const sqlite = new Database(dbFile);
    try {
      migrateSqlite(drizzleSqlite(sqlite), { migrationsFolder: folder });
    } finally {
      sqlite.close();
    }
  };

  // 阶段 A：库停在 0011（生产部署前的样子）
  apply(copyFolder(path.join(tmp, 'up-to-0011'), 11));
  assert.equal(
    columnsOf('notices').has('first_seen_at'),
    false,
    '阶段 A 之后不该有 first_seen_at —— 它属于 0013',
  );

  // 阶段 B：同一份存量库向后迁移到最新（生产上没发生的那一步）
  apply(copyFolder(path.join(tmp, 'full')));
  assert.equal(columnsOf('notices').has('first_seen_at'), true, '0013 被跳过了');
  for (const column of ['scope', 'agencies_json', 'pending_rules_json']) {
    assert.equal(columnsOf('subscriptions').has(column), true, `${column} 缺失：迁移被静默跳过`);
  }
  const sqlite = new Database(dbFile, { readonly: true });
  try {
    assert.ok(
      sqlite
        .prepare("select name from sqlite_master where type='table' and name='notice_notifications'")
        .get(),
      'notice_notifications 表没建出来：0013 被静默跳过',
    );
  } finally {
    sqlite.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});
