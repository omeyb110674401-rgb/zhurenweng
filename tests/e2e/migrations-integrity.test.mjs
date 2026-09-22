// 迁移目录完整性守卫：代码按 drizzle/<driver> 解析迁移目录（src/db/client.ts 的
// migrationsFolder），本测试确保两个方言目录都存在、journal 与 SQL 文件一一对应。
// 背景：曾发生 drizzle/pg 与驱动名 postgres 不一致，导致生产容器启动即崩，
// 而本地 E2E 只用 SQLite 未覆盖——此守卫专门防止该类回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
