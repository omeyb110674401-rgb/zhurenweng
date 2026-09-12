import { ilike, inArray, or, sql } from 'drizzle-orm';
import { currentDriver, getDb } from '../../db/client.ts';
import { notices } from '../../db/schema/sqlite.ts';
import type { SearchDocument, SearchHit, SearchPort } from '../ports.ts';
import { buildFts5MatchQuery, summarySearchText, toCjkSpacedText } from './search-text.ts';

/**
 * SearchPort 本地实现（issue #8，ADR-0001 第 2 条）：开发 / 测试默认检索后端，
 * 零外部依赖 —— 索引与检索都落在应用自己的数据库上。
 *
 * - SQLite（开发 / E2E 方言）：迁移 0004 建立的 FTS5 虚表 `notices_fts`；
 *   文档写入前做 CJK 字间空格变换（见 search-text.ts），查询用短语匹配实现
 *   中文子串命中；按 FTS5 rank（BM25）排序。
 * - PostgreSQL（生产方言）：不建本地索引结构，`index()` / `remove()` 为
 *   no-op，检索退化为对 notices 的 ILIKE（标题 / 正文 / AI 摘要 JSON），
 *   并在应用层按与 FTS 相同的字段语义（标题 / 摘要文本 / 正文，引用不计）
 *   复核候选行 —— 收录量级小（每月数十条），顺序扫描可接受。
 *
 * 同步语义：`index()` 为幂等 upsert（先删后写）；库中条目被外部删除后
 * 可能残留索引孤儿行，检索结果与 notices 表联查兜底（孤儿 id 不会外泄）。
 *
 * 说明：FTS5 虚表不在 drizzle schema 内（drizzle-kit 不建模虚表），
 * 相关语句经 drizzle 原生 SQL 执行，值一律走参数绑定。
 */

/** 检索默认返回条数（结果页与 SearchPort.search 的缺省 limit） */
export const SEARCH_DEFAULT_LIMIT = 20;
/** PG ILIKE 退化路径的候选行上限（应用层复核后再截断到 limit） */
const PG_CANDIDATE_LIMIT = 500;

/** FTS5 单行形状 */
interface FtsRow {
  notice_id: string;
}

export class LocalSearch implements SearchPort {
  readonly provider = 'local';

  async index(documents: SearchDocument[]): Promise<void> {
    if (documents.length === 0 || currentDriver() === 'postgres') return;
    const db = await getDb();
    // 单事务批量 upsert：同 id 先删后写，重复同步幂等。
    // better-sqlite3 的事务回调必须同步执行（drizzle 语句在回调内即时求值）。
    db.transaction((tx) => {
      for (const doc of documents) {
        tx.run(sql`DELETE FROM notices_fts WHERE notice_id = ${doc.id}`);
        tx.run(sql`
          INSERT INTO notices_fts (notice_id, title, summary, body)
          VALUES (${doc.id}, ${toCjkSpacedText(doc.title)}, ${toCjkSpacedText(doc.summary)}, ${toCjkSpacedText(doc.body)})
        `);
      }
    });
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0 || currentDriver() === 'postgres') return;
    const db = await getDb();
    db.transaction((tx) => {
      for (const id of ids) {
        tx.run(sql`DELETE FROM notices_fts WHERE notice_id = ${id}`);
      }
    });
  }

  async search(query: string, limit: number = SEARCH_DEFAULT_LIMIT): Promise<SearchHit[]> {
    const trimmed = query.trim();
    if (trimmed === '' || limit <= 0) return [];
    if (currentDriver() === 'postgres') return this.searchPostgres(trimmed, limit);
    return this.searchSqlite(trimmed, limit);
  }

  /** SQLite：FTS5 短语查询 → 按相关性（rank）取 id → 联库补标题并保持排序。 */
  private async searchSqlite(query: string, limit: number): Promise<SearchHit[]> {
    const matchQuery = buildFts5MatchQuery(query);
    if (matchQuery === null) return [];
    const db = await getDb();
    const rows = (await db.all<FtsRow>(
      sql`SELECT notice_id FROM notices_fts WHERE notices_fts MATCH ${matchQuery} ORDER BY rank LIMIT ${limit}`,
    )) as FtsRow[];
    if (rows.length === 0) return [];

    // 索引孤儿行兜底：只保留库中仍存在的条目，并按 FTS 相关性顺序输出
    const ids = rows.map((row) => row.notice_id);
    const dbRows = await db
      .select({ id: notices.id, title: notices.title })
      .from(notices)
      .where(inArray(notices.id, ids));
    const titleById = new Map(dbRows.map((row) => [row.id, row.title]));
    return ids
      .filter((id) => titleById.has(id))
      .map((id) => ({ id, title: titleById.get(id) ?? '' }));
  }

  /**
   * PostgreSQL：ILIKE 退化查询（标题 / 正文 / AI 摘要 JSON 粗筛）→
   * 应用层按 FTS 同款字段语义复核（摘要只计各段 text，不计原文引用）→
   * 截断到 limit。无相关性排序，按主键稳定输出。
   */
  private async searchPostgres(query: string, limit: number): Promise<SearchHit[]> {
    const db = await getDb();
    const pattern = likePattern(query);
    const rows = await db
      .select({
        id: notices.id,
        title: notices.title,
        bodyText: notices.bodyText,
        aiSummaryJson: notices.aiSummaryJson,
      })
      .from(notices)
      .where(
        or(
          ilike(notices.title, pattern),
          ilike(notices.bodyText, pattern),
          ilike(notices.aiSummaryJson, pattern),
        ),
      )
      .limit(PG_CANDIDATE_LIMIT);
    return rows
      .filter((row) => {
        const summary = summarySearchText(safeParse(row.aiSummaryJson));
        return (
          row.title.includes(query) ||
          (row.bodyText ?? '').includes(query) ||
          summary.includes(query)
        );
      })
      .slice(0, limit)
      .map((row) => ({ id: row.id, title: row.title }));
  }
}

/** ILIKE 模式串：转义 % _ 与转义符本身，保证用户输入按字面子串匹配 */
function likePattern(query: string): string {
  return `%${query.replaceAll(/[\\%_]/g, '\\$&')}%`;
}

function safeParse(text: string | null): unknown {
  if (text === null || text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
