#!/usr/bin/env node
import { reindexAllNotices } from '../src/lib/search/sync.ts';

/**
 * 检索索引一次性全量重建入口（issue #8）：只重刷索引，不跑抓取 / 摘要。
 * 适用于更换检索后端（SEARCH_PROVIDER）、首次接入或手动修复索引。
 *
 *   SEARCH_PROVIDER=meilisearch MEILI_HOST=... node scripts/reindex-search.mjs
 *   node scripts/reindex-search.mjs   # 默认 local（SQLite FTS5）
 */

const log = (message) => console.log(`[reindex-search] ${new Date().toISOString()} ${message}`);

await reindexAllNotices(log);
process.exit(0);
