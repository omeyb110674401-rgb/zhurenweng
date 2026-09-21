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

/** 迁移串行化用的固定 advisory lock 键（任意常量，全项目唯一即可）。 */
const MIGRATION_LOCK_KEY = 2055178350;

async function openDatabase(): Promise<AppDatabase> {
  const driver = currentDriver();
  if (driver === 'postgres') return openPostgres();
  return openSqlite();
}

async function openPostgres(): Promise<AppDatabase> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // 超时四件套（issue #51）：pg 的默认值是「无限等」。TCP 连上了但服务端不响应、
    // 或连接池被占满时，查询会一直挂着：web 是 force-dynamic SSR，每个请求都要查库
    // —— 池子一挂整站一起卡死，且没有任何日志或告警；worker 的任务是串行的，一个
    // 挂住的查询就让整轮抓取停在那里。取值依据：本库量级数百行、正常查询毫秒级，
    // 5s 建连 / 15s 语句已比正常路径宽两个数量级。
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 15_000,
    max: 10,
  });
  const db = drizzlePostgres(pool, { schema: postgresSchema });
  // 并发启动竞态：compose 同时拉起 web/worker，两者都会执行迁移，裸跑会因
  // __drizzle_migrations 表重复创建而崩（实测 23505 duplicate key）。用会话级
  // advisory lock 串行化：后到者等待，随后发现迁移已应用即空跑。
  const lockClient = await pool.connect();
  try {
    // 等锁也算「语句耗时」，会被 statement_timeout 掐掉 —— 迁移这一条连接上关掉它
    // （另一容器正在迁时，等多久取决于对方的迁移时长，不该被 15s 判死）。
    await lockClient.query('SET statement_timeout = 0');
    await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await migratePostgres(db, { migrationsFolder: migrationsFolder('postgres') });
  } finally {
    await lockClient
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => {});
    lockClient.release();
  }
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
