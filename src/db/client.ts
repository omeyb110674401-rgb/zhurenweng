import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { migrate as migratePostgres } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as postgresSchema from './schema/postgres.ts';
import * as sqliteSchema from './schema/sqlite.ts';

/**
 * 数据库客户端（ADR-0001）：DB_DRIVER=sqlite（默认，开发 / 测试）或 postgres（生产）。
 *
 * 仓库层统一面向 `AppDatabase` 类型编写；两个 schema 是彼此的镜像（列名一致、
 * 只用双方言交集子集），运行时由当前连接的方言生成 SQL。
 * 连接为进程内单例，首次创建时自动应用 drizzle/<driver>/ 下的迁移。
 */

export type AppDatabase = BetterSQLite3Database<typeof sqliteSchema>;

export type DbDriver = 'sqlite' | 'postgres';

let cached: Promise<AppDatabase> | undefined;

/** 取得数据库单例；首次调用时打开连接并执行迁移。 */
export function getDb(): Promise<AppDatabase> {
  cached ??= openDatabase();
  return cached;
}

/** 仅测试使用：丢弃已缓存的连接（不会关闭已打开的连接）。 */
export function resetDbCacheForTests(): void {
  cached = undefined;
}

export function currentDriver(): DbDriver {
  const driver = process.env.DB_DRIVER ?? 'sqlite';
  if (driver !== 'sqlite' && driver !== 'postgres') {
    throw new Error(`不支持的 DB_DRIVER "${driver}"，可选值：sqlite | postgres`);
  }
  return driver;
}

function migrationsFolder(driver: DbDriver): string {
  return path.join(process.cwd(), 'drizzle', driver);
}

async function openDatabase(): Promise<AppDatabase> {
  const driver = currentDriver();
  if (driver === 'postgres') return openPostgres();
  return openSqlite();
}

async function openPostgres(): Promise<AppDatabase> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzlePostgres(pool, { schema: postgresSchema });
  await migratePostgres(db, { migrationsFolder: migrationsFolder('postgres') });
  // 两个 schema 互为镜像（见文件头注释），对调用方暴露统一类型。
  return db as unknown as AppDatabase;
}

function openSqlite(): AppDatabase {
  const url = process.env.DATABASE_URL ?? 'data/zhurenweng.db';
  const file = path.resolve(/* turbopackIgnore: true */ url);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzleSqlite(sqlite, { schema: sqliteSchema });
  migrateSqlite(db, { migrationsFolder: migrationsFolder('sqlite') });
  return db;
}
