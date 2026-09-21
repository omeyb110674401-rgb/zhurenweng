import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { getDb } from '../client.ts';
import { notices, outboundClickDaily } from '../schema/sqlite.ts';
import { syncNoticeVersionLinks } from './versions.ts';
import { localDateIso } from '../../lib/dates.ts';
import { deriveCategoryTags } from '../../lib/categories.ts';
import { agencyKeysOf, canonicalAgency, splitAgencies } from '../../lib/agencies.ts';
import {
  safeParseJson,
  safeParseJsonArray,
  type NoticeAttachment,
  type NoticeRecord,
  type NoticeStatus,
} from '../types.ts';

export interface ListNoticesOptions {
  limit?: number;
}

/**
 * 抓取管线写入的条目形状（幂等 upsert 的输入）。
 * id 由调用方按原文 URL 确定性生成（sha256 前缀），重复抓取命中同一行。
 */
export interface UpsertNoticeInput {
  id: string;
  sourceId: string;
  title: string;
  agency: string;
  url: string;
  publishedAt: string | null;
  deadlineAt: string | null;
  status: NoticeStatus;
  /**
   * 领域标签（issue #9）：可选。未提供（undefined）时由入库路径按关键词规则
   * 自动打标（src/lib/categories.ts 的 deriveCategoryTags）——抓取管线与手动
   * 补录共用本入口，自动打标只此一处；显式传入数组（含空数组）时以传入值为准
   * （E2E 合成条目、未来适配器规则的逃生门）。
   */
  categoryTags?: string[];
  bodyText: string | null;
  attachments: NoticeAttachment[];
  fetchedAt: string;
}

/**
 * 聚合列表排序（issue #3，列表页所有查询共用）：
 * 1. 征求意见中在前，已截止 / 已出结果沉底；
 * 2. 组内按截止日期升序（即将截止在前），无截止日期的排最后；
 * 3. 以抓取时间降序兜底。
 * 双方言交集下 NULL 排序位置不同（SQLite 在前、PostgreSQL 在后），
 * 故用显式 CASE 归一化。
 */
const AGGREGATION_ORDER = [
  sql`case when ${notices.status} = 'open' then 0 else 1 end`,
  sql`case when ${notices.deadlineAt} is null then 1 else 0 end`,
  asc(notices.deadlineAt),
  desc(notices.fetchedAt),
];

export async function listNotices(options: ListNoticesOptions = {}): Promise<NoticeRecord[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(notices)
    .orderBy(...AGGREGATION_ORDER)
    .limit(options.limit ?? 50);
  return rows.map(toNoticeRecord);
}

/**
 * 分类浏览查询（issue #9）：领域标签 / 发布机关 / 关键词三维度可任意组合
 * （全部可分享于 querystring：/?category=…&agency=…&q=…），排序沿用
 * AGGREGATION_ORDER 的倒计时排序 —— 筛选只过滤行，不改变顺序。
 *
 * 过滤语义：
 * - category：领域标签精确命中（categoryTagsJson 存 JSON 数组文本，用带引号
 *   的整词匹配，避免子串误命中——查「数据」不会命中「数据与网络安全」）；
 * - agency：发布机关精确相等；
 * - keyword：标题或正文包含匹配（lower() 后比对，Latin 不区分大小写；
 *   关键词中的 % / _ 按 LIKE 通配符解释，参数化绑定无注入面）。
 */
export interface ListNoticesFilteredOptions {
  /** 领域标签精确值（应为 src/lib/categories.ts 词表内的标签） */
  category?: string;
  /** 发布机关精确值 */
  agency?: string;
  /**
   * 标题 / 正文包含匹配的关键词；**空白分隔的多个词 = 都要命中**（子串、忽略大小写）。
   * 通配符按字面处理（issue #33：`%` / `_` 不再被当成 LIKE 通配）。
   */
  keyword?: string;
  limit?: number;
  /** 分页偏移（首页分页用；默认 0）。排序是确定性的（见 AGGREGATION_ORDER），
   *  故同一查询条件下 offset 分页不会重复或漏行。 */
  offset?: number;
}

/**
 * 关键词最多取前 N 个词：粘贴整段话时不必生成几十个 LIKE 条件（超出部分忽略）。
 */
const KEYWORD_TERM_LIMIT = 10;

/** LIKE 模式串里的字面量：转义 `\` `%` `_`（配合 SQL 侧的 `escape '\'`）。 */
function likeLiteral(term: string): string {
  return term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/**
 * 关键词条件（issue #33）：按空白拆词，逐词做「标题或正文包含」的**子串**匹配，词之间 AND。
 *
 * 为什么必须拆词：此前把整串当一个子串匹配，于是**任何多词输入都必然零命中** ——
 * 线上实测首页「未成年 网络」0 条（搜索页 12 条）、「医疗保障 监督检查」0 条（搜索页 4 条）。
 * 筛选框的提示语是「标题 / 正文关键词」，用户输入两个词是常态；「筛选后共 0 条」把
 * 「库里没有」和「筛选写错了」混成了同一种表现。
 *
 * 为什么必须转义 LIKE 通配符：`%` 与 `_` 在 LIKE 模式串里是通配符，用户输入会被当成通配 ——
 * 线上实测 `?q=%` 返回全部 178 条、`?q=50%` 返回 12 条（都含「50」）。逐词转义并显式
 * `escape '\'` 后，两种方言（SQLite / PostgreSQL）行为一致。
 *
 * 与搜索页（/search）的口径差异（刻意保留，各有用途）：本函数是子串匹配、不依赖检索索引、
 * 不改变列表的截止日期排序 —— 检索服务不可用时首页筛选照样可用；搜索页走索引（中文按词
 * 切分、英文前缀匹配、按相关度排序，并额外匹配 AI 摘要文本），多词查询会带上只命中部分词
 * 的条目并排在后面。中文**单词**查询两边结果一致。
 */
function keywordCondition(keyword: string) {
  const terms = keyword
    .split(/\s+/)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 0)
    .slice(0, KEYWORD_TERM_LIMIT);
  if (terms.length === 0) return undefined;
  return and(
    ...terms.map(
      (term) =>
        sql`(lower(${notices.title}) like ${`%${likeLiteral(term)}%`} escape '\\' or lower(${notices.bodyText}) like ${`%${likeLiteral(term)}%`} escape '\\')`,
    ),
  );
}

/**
 * 筛选条件（listNoticesFiltered 与 countNoticesFiltered 共用）：
 * 两处的 WHERE 必须完全一致，否则「共 N 条」与实际能翻到的行数会打架。
 */
function filterConditions(options: ListNoticesFilteredOptions) {
  const conditions = [];
  if (options.category) {
    // JSON 数组文本形如 ["医疗卫生","市场监管"]：用 %“带引号整词”% 包含匹配，
    // 引号保证元素级完整命中（查「数据」不会命中「数据与网络安全」）
    conditions.push(
      sql`${notices.categoryTagsJson} like ${`%${JSON.stringify(options.category)}%`}`,
    );
  }
  if (options.agency) {
    // 按任一参与机关命中（issue #21）：联合发文（「司法部、中国人民银行…」）在
    // agency 列是复合串，靠 agency_keys 的竖线包夹串才能被任一参与机关筛到。
    // 同时保留 agency 精确相等 —— 旧行（迁移前入库、尚未重抓）agency_keys 为空。
    conditions.push(
      or(
        eq(notices.agency, options.agency),
        sql`${notices.agencyKeys} like ${`%|${options.agency}|%`}`,
      ),
    );
  }
  if (options.keyword) {
    const keyword = keywordCondition(options.keyword);
    if (keyword) conditions.push(keyword);
  }
  return conditions;
}

export async function listNoticesFiltered(
  options: ListNoticesFilteredOptions = {},
): Promise<NoticeRecord[]> {
  const db = await getDb();
  const conditions = filterConditions(options);
  const rows = await db
    .select()
    .from(notices)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(...AGGREGATION_ORDER)
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0);
  return rows.map(toNoticeRecord);
}

/**
 * 同筛选条件下的**总条数**（首页分页的「共 N 条」与总页数）。
 *
 * 与 listNoticesFiltered 共用 filterConditions，保证计数与列表口径一致。
 * count(*) 在双方言下返回类型不同（PostgreSQL 的 bigint 走字符串），统一 Number()。
 */
export async function countNoticesFiltered(
  options: ListNoticesFilteredOptions = {},
): Promise<number> {
  const db = await getDb();
  const conditions = filterConditions(options);
  const rows = await db
    .select({ value: sql<number>`count(*)` })
    .from(notices)
    .where(conditions.length > 0 ? and(...conditions) : undefined);
  return Number(rows[0]?.value ?? 0);
}

/**
 * 库内去重后的发布机关清单（issue #9 列表页机关筛选下拉选项），按名称排序。
 */
export async function listNoticeAgencies(): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .selectDistinct({ agency: notices.agency })
    .from(notices)
    .orderBy(asc(notices.agency));
  // 拆成参与机关集合（issue #21）：下拉里列的是机关而不是「机关组合串」，
  // 联合发文的每个参与机关都能被单独选中。旧行未重抓时 agency_keys 为空，
  // 这里直接按 agency 现拆（与入库用的是同一个拆分函数，口径一致）。
  const names = new Set<string>();
  for (const row of rows) {
    for (const name of splitAgencies(row.agency)) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * RSS feed 查询（issue #6）：全量条目按发布日期倒序（最新发布在前）。
 * 与聚合列表（listNotices）的「截止日期升序」排序不同：feed 是时间线语义。
 * 无发布日期的条目排最后 —— 显式 CASE 归一化 NULL 排序位置（双方言下
 * SQLite 与 PostgreSQL 的 NULL 排序方向相反），同日按抓取时间、条目 ID
 * 兜底保证顺序稳定。
 */
export async function listNoticesByPublishedDesc(
  options: ListNoticesOptions = {},
): Promise<NoticeRecord[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(notices)
    .orderBy(
      sql`case when ${notices.publishedAt} is null then 1 else 0 end`,
      desc(notices.publishedAt),
      desc(notices.fetchedAt),
      asc(notices.id),
    )
    .limit(options.limit ?? 200);
  return rows.map(toNoticeRecord);
}

/** 按主键取单条；不存在返回 null（详情页与 /go 端点使用）。 */
export async function getNoticeById(id: string): Promise<NoticeRecord | null> {
  const db = await getDb();
  const rows = await db.select().from(notices).where(eq(notices.id, id)).limit(1);
  return rows.length > 0 ? toNoticeRecord(rows[0]) : null;
}

/**
 * 按主键批量取条目，返回顺序与传入 ids 一致（检索结果按相关性排序，
 * 页面渲染必须保持该顺序）；库中不存在的 id 被跳过（索引孤儿行兜底）。
 * 空列表直接返回空数组（inArray 空集无意义）。
 */
export async function getNoticesByIds(ids: string[]): Promise<NoticeRecord[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  const rows = await db.select().from(notices).where(inArray(notices.id, ids));
  const byId = new Map(rows.map((row) => [row.id, toNoticeRecord(row)]));
  return ids.flatMap((id) => {
    const record = byId.get(id);
    return record ? [record] : [];
  });
}

/**
 * 全量条目（检索索引重建用，issue #8）：收录量级为每月数十条，
 * 一次取全量即可；按主键排序保证重建输出稳定。
 */
export async function listAllNoticesForReindex(): Promise<NoticeRecord[]> {
  const db = await getDb();
  const rows = await db.select().from(notices).orderBy(asc(notices.id));
  return rows.map(toNoticeRecord);
}

/**
 * 幂等入库：以原文 URL 为唯一键。已存在则更新内容字段（标题、机关、日期、
 * 状态、正文、附件、抓取时间），不触碰 id / 点击计数 / AI 摘要（属摘要管线）。
 * 返回 'inserted' | 'updated' 供抓取日志统计。
 *
 * 领域标签自动打标（issue #9）：调用方未提供 categoryTags 时，按关键词规则
 * 从标题 / 正文推导（src/lib/categories.ts），更新路径同样重算——重复抓取
 * 后标签始终与最新标题 / 正文一致。这是抓取管线与手动补录共用的唯一打标入口。
 *
 * 入库 / 更新后自动同步版本链（issue #10）：同一法案不同轮次公示按
 * 标题规范化 + 同机关关联为版本链（见 ./versions.ts），对调用方透明。
 */
export async function upsertNotice(input: UpsertNoticeInput): Promise<'inserted' | 'updated'> {
  const db = await getDb();
  const categoryTags = input.categoryTags ?? deriveCategoryTags(input.title, input.bodyText);
  const existing = await db
    .select({ id: notices.id, title: notices.title, agency: notices.agency })
    .from(notices)
    .where(eq(notices.url, input.url))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(notices)
      .set({
        title: input.title,
        agency: canonicalAgency(input.agency),
        agencyKeys: agencyKeysOf(input.agency),
        publishedAt: input.publishedAt,
        deadlineAt: input.deadlineAt,
        status: input.status,
        categoryTagsJson: JSON.stringify(categoryTags),
        bodyText: input.bodyText,
        attachmentsJson: JSON.stringify(input.attachments),
        fetchedAt: input.fetchedAt,
      })
      .where(eq(notices.url, input.url));
    // 版本链同步（issue #10）：标题 / 机关变化时旧链同样重算
    await syncNoticeVersionLinks({
      id: existing[0].id,
      title: input.title,
      agency: canonicalAgency(input.agency),
      previous: { title: existing[0].title, agency: existing[0].agency },
    });
    return 'updated';
  }

  await db.insert(notices).values({
    id: input.id,
    sourceId: input.sourceId,
    title: input.title,
    agency: canonicalAgency(input.agency),
    agencyKeys: agencyKeysOf(input.agency),
    url: input.url,
    publishedAt: input.publishedAt,
    deadlineAt: input.deadlineAt,
    status: input.status,
    categoryTagsJson: JSON.stringify(categoryTags),
    bodyText: input.bodyText,
    attachmentsJson: JSON.stringify(input.attachments),
    fetchedAt: input.fetchedAt,
  });
  // 版本链同步（issue #10）：首版入库时自动尝试与既有条目关联
  await syncNoticeVersionLinks({
    id: input.id,
    title: input.title,
    agency: canonicalAgency(input.agency),
  });
  return 'inserted';
}

/**
 * 出站提意点击 +1（北极星指标）。只记录条目与时间，不记录任何个人身份。
 * 写两处：notices.outbound_clicks 总计数（issue #5）+ outbound_click_daily
 * 按（条目 × 本地日历日）聚合行（issue #11 统计页按日期聚合用）。
 * 条目不存在返回 null。
 */
export async function recordOutboundClick(id: string): Promise<number | null> {
  const db = await getDb();
  const rows = await db
    .update(notices)
    .set({ outboundClicks: sql`${notices.outboundClicks} + 1` })
    .where(eq(notices.id, id))
    .returning({ outboundClicks: notices.outboundClicks });
  if (rows.length === 0) return null;

  // 按日聚合行 upsert：复合主键（条目 × 日期）幂等，同日重复点击按行累加
  await db
    .insert(outboundClickDaily)
    .values({ noticeId: id, clickDate: localDateIso(new Date()), clicks: 1 })
    .onConflictDoUpdate({
      target: [outboundClickDaily.noticeId, outboundClickDaily.clickDate],
      set: { clicks: sql`${outboundClickDaily.clicks} + 1` },
    });
  return rows[0].outboundClicks;
}

function toNoticeRecord(row: typeof notices.$inferSelect): NoticeRecord {
  return {
    id: row.id,
    sourceId: row.sourceId,
    title: row.title,
    agency: row.agency,
    url: row.url,
    publishedAt: row.publishedAt,
    deadlineAt: row.deadlineAt,
    status: row.status as NoticeStatus,
    categoryTags: safeParseJsonArray(row.categoryTagsJson),
    bodyText: row.bodyText,
    attachments: parseAttachments(row.attachmentsJson),
    aiSummary: safeParseJson(row.aiSummaryJson),
    summaryModel: row.summaryModel,
    fetchedAt: row.fetchedAt,
    outboundClicks: row.outboundClicks,
    versionOf: row.versionOf,
    versionSeq: row.versionSeq,
  };
}

function parseAttachments(text: string): NoticeAttachment[] {
  const parsed = safeParseJson(text);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => {
      if (typeof item !== 'object' || item === null) return null;
      const record = item as Record<string, unknown>;
      if (typeof record.name !== 'string' || typeof record.url !== 'string') return null;
      return { name: record.name, url: record.url };
    })
    .filter((item): item is NoticeAttachment => item !== null);
}
