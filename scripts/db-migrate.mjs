#!/usr/bin/env node
import { getDb, currentDriver } from '../src/db/client.ts';

/**
 * 迁移 CLI：按 DB_DRIVER（默认 sqlite）打开数据库并应用 drizzle/<driver>/ 下的迁移
 * （连接单例首次创建时自动迁移，逻辑见 src/db/client.ts）。
 *
 * 生产 compose 使用：
 *   DB_DRIVER=postgres DATABASE_URL=... node scripts/db-migrate.mjs
 */

const driver = currentDriver();
await getDb();
console.log(`[db-migrate] ${driver} 迁移已应用`);
process.exit(0);
