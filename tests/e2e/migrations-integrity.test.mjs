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
