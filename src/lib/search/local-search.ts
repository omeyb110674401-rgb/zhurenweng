import { ilike, inArray, or, sql } from 'drizzle-orm';
import { currentDriver, getDb } from '../../db/client.ts';
import { notices } from '../../db/schema/sqlite.ts';
import {
  SEARCH_DEFAULT_PER_PAGE,
  type SearchDocument,
  type SearchOptions,
  type SearchPort,
  type SearchResult,
} from '../ports.ts';
import { buildFts5MatchQuery, hasSearchableQuery, summarySearchText, toCjkSpacedText } from './search-text.ts';

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

/** PG ILIKE 退化路径的候选行上限（应用层复核后再截断到 limit） */
const PG_CANDIDATE_LIMIT = 500;

/** FTS5 单行形状 */
interface FtsRow {
  notice_id: string;
}

/** 计数查询单行形状 */
interface CountRow {
  total: number;
}

/** 页码归一：非正整数一律当第 1 页（与结果页的 URL 参数口径一致）。 */
function normalizePage(page: number | undefined): number {
  return Number.isInteger(page) && (page ?? 0) > 0 ? (page as number) : 1;
}

/** 每页条数归一：非正数退回缺省值。 */
function normalizePerPage(perPage: number | undefined): number {
  return Number.isInteger(perPage) && (perPage ?? 0) > 0 ? (perPage as number) : SEARCH_DEFAULT_PER_PAGE;
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

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const trimmed = query.trim();
    const perPage = normalizePerPage(options.perPage);
    const page = normalizePage(options.page);
    // 无词元查询（纯标点 / 空白）一律无命中 —— 与 Meilisearch 适配器共用同一判据，
    // 免得两条路径给出不同答案（issue #32：Meilisearch 那边会把整库当命中返回）
    if (!hasSearchableQuery(trimmed)) return { total: 0, hits: [] };
    if (currentDriver() === 'postgres') return this.searchPostgres(trimmed, page, perPage);
    return this.searchSqlite(trimmed, page, perPage);
  }

  /**
   * SQLite：FTS5 短语查询 → 计数 + 按相关性（rank）取当前页 id → 联库补标题并保持排序。
   *
   * 计数单独查一次：结果页要如实说「共 N 条」，而 N 与当前页条数是两件事
   * （issue #31 —— 此前结果页把「本页条数」当总数，176 条命中显示成 50 条）。
   * 计数同样排除索引孤儿行（条目已从 notices 删除）：页面上的数字必须等于
   * 用户实际能点开的条目数，否则分页的末页会短一截且总数对不上。
   */
  private async searchSqlite(query: string, page: number, perPage: number): Promise<SearchResult> {
    const matchQuery = buildFts5MatchQuery(query);
    if (matchQuery === null) return { total: 0, hits: [] };
    const db = await getDb();
    const countRows = (await db.all<CountRow>(
      sql`SELECT count(*) AS total FROM notices_fts
          WHERE notices_fts MATCH ${matchQuery}
            AND EXISTS (SELECT 1 FROM notices WHERE notices.id = notices_fts.notice_id)`,
    )) as CountRow[];
    const total = Number(countRows[0]?.total ?? 0);
    if (total === 0) return { total: 0, hits: [] };

    const offset = (page - 1) * perPage;
    const rows = (await db.all<FtsRow>(
      sql`SELECT notice_id FROM notices_fts WHERE notices_fts MATCH ${matchQuery}
          ORDER BY rank LIMIT ${perPage} OFFSET ${offset}`,
    )) as FtsRow[];
    if (rows.length === 0) return { total, hits: [] };

    // 索引孤儿行兜底：只保留库中仍存在的条目，并按 FTS 相关性顺序输出
    const ids = rows.map((row) => row.notice_id);
    const dbRows = await db
      .select({ id: notices.id, title: notices.title })
      .from(notices)
      .where(inArray(notices.id, ids));
    const titleById = new Map(dbRows.map((row) => [row.id, row.title]));
    return {
      total,
      hits: ids
        .filter((id) => titleById.has(id))
        .map((id) => ({ id, title: titleById.get(id) ?? '' })),
    };
  }

  /**
   * PostgreSQL：ILIKE 退化查询（标题 / 正文 / AI 摘要 JSON 粗筛）→
   * 应用层按 FTS 同款字段语义复核（摘要只计各段 text，不计原文引用）→ 取当前页。
   * 无相关性排序，按主键稳定输出。
   *
   * `total` 取复核后的命中数；候选行触及 PG_CANDIDATE_LIMIT 时它是**下界**
   * （复核无法在 SQL 里表达，只能在候选集上做）—— 本部署规模（数百条）不会触及，
   * 且生产走 Meilisearch（精确 totalHits），此路径只在无 Meilisearch 的 PG 部署上生效。
   */
  private async searchPostgres(
    query: string,
    page: number,
    perPage: number,
  ): Promise<SearchResult> {
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
    const matched = rows.filter((row) => {
      const summary = summarySearchText(safeParse(row.aiSummaryJson));
      return (
        row.title.includes(query) ||
        (row.bodyText ?? '').includes(query) ||
        summary.includes(query)
      );
    });
    const offset = (page - 1) * perPage;
    return {
      total: matched.length,
      hits: matched
        .slice(offset, offset + perPage)
        .map((row) => ({ id: row.id, title: row.title })),
    };
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
