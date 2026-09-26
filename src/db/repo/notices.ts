import { and, asc, desc, eq, gte, inArray, isNull, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { currentDriver, getDb } from '../client.ts';
import { noticeAttachments, notices, outboundClickDaily, sources } from '../schema/sqlite.ts';
import { syncNoticeVersionLinks } from './versions.ts';
import { siteDateIso } from '../../lib/dates.ts';
import { splitSearchTerms } from '../../lib/search/search-text.ts';
import { PERIOD_BUCKETS, type PeriodBucketKey } from '../../lib/notice-period.ts';
import { recencyCutoffIso } from '../../lib/notice-recency.ts';
import type { NoticeSortKey } from '../../lib/notice-sort.ts';
import { deriveCategoryTags } from '../../lib/categories.ts';
import { deriveNoticeGenre, genreDecisionWins, type GenreEvidenceKind } from '../../lib/notice-genre.ts';
import { agencyKeysOf, canonicalAgency, splitAgencies } from '../../lib/agencies.ts';
import {
  safeParseJson,
  safeParseJsonArray,
  type NoticeAttachment,
  type NoticeRecord,
  type NoticeStatus,
} from '../types.ts';

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
 * 1. **还能提意见的在前**，已截止 / 已出结果沉底；
 * 2. 组内按截止日期升序（即将截止在前），无截止日期的排最后；
 * 3. 以抓取时间降序兜底。
 * 双方言交集下 NULL 排序位置不同（SQLite 在前、PostgreSQL 在后），
 * 故用显式 CASE 归一化。
 *
 * **第一档为什么不用库内 `status` 列（issue #79，2026-09-26 改）**：那是**抓取时**推导的缓存，
 * 而抓取每日一轮 —— 昨天到期的那批在下一轮抓取改口之前仍是 `open`，于是首页头屏
 * 排满了页面自己标着「已截止」的条目（生产实测：头屏 9 条、整页 50 条里 18 条）。
 * 一个以「出站提意点击数」为北极星的站，第一屏不能是已经提不了意见的东西。
 * 所以第一档改用 `stillOpen()`（= `?open=1` 的 WHERE、统计页「未截止」列的同一份判据）。
 * 这三处从此同源：排序看到的"还能提"，就是徽标和筛选器说的"还能提"。
 *
 * **必须每次查询现算，不能提成模块级常量**：这一档里的"今天"来自 `siteDateIso(new Date())`，
 * 而 web 进程是长期驻留的（容器不重启就一直跑）。写成模块级常量等于把"今天"冻结在
 * 进程启动那一刻 —— 午夜过后新过期的条目仍按未截止排序，直到下次重启。这个坑和
 * `openCondition()` 当初写成函数是同一个理由，只是排序这一档更容易被顺手提成常量。
 *
 * **末位必须补唯一键 `id`（issue #54）**：上面四个键都不唯一 —— 同一轮抓取入库的
 * 一批条目，status / deadlineAt / fetchedAt 可以完全相同（fetchedAt 是本轮的批次
 * 时间戳，不是逐条生成的）。而分页是 `LIMIT n OFFSET m`，并列行的相对次序由数据库
 * 的排序实现决定：`ORDER BY ... LIMIT 50 OFFSET 0` 与 `LIMIT 50 OFFSET 50` 的有界
 * top-N 排序取的 N 不同，并列行在两页里被摆到不同的位置。线上实测的后果是页边界上
 * 同一条目在两页各出现一次、另一条目被挤出所有页面（收录了却从导航不可达）。
 * 补上唯一键让全序成立，分页切片才互不重叠、合起来恰好等于全集。
 * `id` 由原文 URL 的 sha256 前缀确定性生成（见 UpsertNoticeInput），天然唯一且稳定。
 */
function aggregationOrder(): SQL[] {
  return [
    sql`case when ${stillOpen()} then 0 else 1 end`,
    sql`case when ${notices.deadlineAt} is null then 1 else 0 end`,
    asc(notices.deadlineAt),
    desc(notices.fetchedAt),
    asc(notices.id),
  ];
}

/**
 * 各排序档位的 SQL 实现（issue #62；档位清单在 lib/notice-sort.ts，那里说明为什么
 * 清单不放这一层）。默认 `deadline` 就是原来的 `AGGREGATION_ORDER` —— 不传参数时
 * **一字不差**，首页与既有钻取链接、以及所有没改过的调用方行为不变。
 * （2026-09-26 起这一档的第一键改按展示口径判未截止，见 `aggregationOrder()` 的说明。）
 *
 * 写成 `Record<NoticeSortKey, …>` 而不是 switch：加一档而忘了在这里补实现会**编译不过**，
 * switch 带 default 时则会静默退化成默认排序（`?sort=` 看着生效了，实际什么都没变）。
 *
 * 每一档末位都必须是 `asc(id)`：#54 的教训是「排序不唯一 ⇒ `LIMIT/OFFSET` 分页会在页边界
 * 重复一行、挤掉另一行」，而并列在这几个字段上极常见（同一轮抓进来的批次时间戳相同、
 * 点击数大量为 0）。新增排序时若忘了这个尾键，测试照样全绿、线上才会出错。
 *
 * 与 `aggregationOrder()` 同理，各档也要**现算**（`deadline` / `clicks` 两档里含
 * 「今天」），所以这里存的是构造函数而不是数组。
 */
const NULLS_LAST = (column: SQLWrapper) => sql`case when ${column} is null then 1 else 0 end`;

const ORDERS: Record<NoticeSortKey, () => SQL[]> = {
  deadline: aggregationOrder,
  // 最新发布：缺发布日期的沉底（与统计页「缺发布日期不计入分布」同一口径）。
  // RSS feed 也走这一档（issue #6 的 feed 是时间线语义，不是倒计时序）——
  // 原先那里另有一份 `listNoticesByPublishedDesc`，两处排序迟早分家，已合并到这一档。
  published: () => [
    NULLS_LAST(notices.publishedAt),
    desc(notices.publishedAt),
    desc(notices.fetchedAt),
    asc(notices.id),
  ],
  // 最近收录：按 first_seen_at（建行时写入、不随每日抓取覆盖），不是 fetched_at
  newest: () => [
    NULLS_LAST(notices.firstSeenAt),
    desc(notices.firstSeenAt),
    asc(notices.id),
  ],
  // 提意见最多：并列（大量条目为 0）时再按倒计时排，避免"同分随机序"
  clicks: () => [desc(notices.outboundClicks), ...aggregationOrder()],
};

function orderFor(sort: NoticeSortKey | undefined): SQL[] {
  return ORDERS[sort ?? 'deadline']();
}

/**
 * 分类浏览查询（issue #9）：领域标签 / 发布机关 / 关键词三维度可任意组合
 * （全部可分享于 querystring：/?category=…&agency=…&q=…），默认排序沿用
 * `aggregationOrder()` 的倒计时排序；传 sort 换口径（issue #62，见 NOTICE_SORT_KEYS）。
 *
 * 过滤语义：
 * - category：领域标签精确命中（categoryTagsJson 存 JSON 数组文本，用带引号
 *   的整词匹配，避免子串误命中——查「数据」不会命中「数据与网络安全」）；
 * - agency：发布机关精确相等（默认按**任一参与机关**命中，见 leadAgencyOnly）；
 * - keyword：标题或正文包含匹配（lower() 后比对，Latin 不区分大小写；
 *   关键词中的 % / _ 按字面处理，见 keywordCondition）。
 */
export interface ListNoticesFilteredOptions {
  /** 领域标签精确值（应为 src/lib/categories.ts 词表内的标签） */
  category?: string;
  /**
   * 来源渠道 ID（`sources.id`，issue #65）：精确相等。与 `agency` 同一处理方式 ——
   * **不做白名单**（值来自登记表，登记表是会变的；不认识的 ID 筛出 0 条并把该值
   * 回显在下拉里，见 app/page.tsx 的 issue #39 那段），而 `category` 之所以白名单，
   * 是因为那份词表写死在代码里、页面与它不可能不一致。
   */
  sourceId?: string;
  /**
   * 发布机关精确值。默认按**任一参与机关**命中（issue #21：联合发文
   * 「司法部 国家发展改革委」选任一方都能筛到）；设 leadAgencyOnly 后只算牵头机关。
   */
  agency?: string;
  /**
   * 机关筛选只算**牵头机关**（issue #36）：与统计页「各部门公示量」同一口径
   * （统计按牵头机关归并，联合发文只记一次，否则各部门之和会超过条目总数）。
   * 由统计页的钻取链接带 `?agency=X&lead=1` 使用；不带时是「任一参与机关」。
   */
  leadAgencyOnly?: boolean;
  /**
   * 标题 / 正文包含匹配的关键词；**空白分隔的多个词 = 都要命中**（子串、忽略大小写）。
   * 通配符按字面处理（issue #33：`%` / `_` 不再被当成 LIKE 通配）。
   */
  keyword?: string;
  /**
   * 发布月份区间（YYYY-MM，含两端；issue #48）：统计页趋势表的钻取链接用 ——
   * 月份格子用 from = to = 该月，行小计 / 总计用窗口的起止月。
   *
   * 口径必须与 stats.ts 的 `substr(published_at, 1, 7)` 一致（两处不一致，
   * 「点进去的条数 = 表格上的数字」就不成立 —— issue #36 定的不变式）。
   * 调用方保证格式合法（见 app/_lib/home-query.ts 的 monthRangeParam）。
   */
  publishedFromMonth?: string;
  publishedToMonth?: string;
  /**
   * 公示期分桶（issue #47）：统计页「公示期长度分布」的钻取链接用。
   * 桶边界与文案统一在 `src/lib/notice-period.ts`，这里的 SQL 条件由同一份
   * 定义推导（不另写一套边界）。
   */
  periodBucket?: PeriodBucketKey;
  limit?: number;
  /**
   * 排序口径（issue #62）：未传 = 默认倒计时序（`deadline`），与首页既有行为一字不差。
   * 档位清单在 lib/notice-sort.ts；每档的末位都强制 `asc(id)`，理由见上面 `ORDERS` 的注释。
   */
  sort?: NoticeSortKey;
  /**
   * 只看"还没截止"的条目（issue #62）。按**展示口径**判而不是库列：
   * 已过截止但还没被下一轮抓取改口的条目不该出现在这里（#43 的同一件事）。
   */
  openOnly?: boolean;
  /** 只看最近 N 天内首次收录的条目（「最近新增」；`first_seen_at` 为 NULL 的存量不进来） */
  firstSeenWithinDays?: number;
  /**
   * 分页偏移（issue #19 的翻页）。排序必须**全序**（每档末位的 `asc(id)` 尾键，见 `ORDERS`），
   * 故同一查询条件下 offset 分页不会重复或漏行。 */
  offset?: number;
}

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
 * 与搜索页（/search）的口径（issue #50 统一）：**多词查询两边都是「全部词都要命中」**，
 * 拆词规则也共用同一份（lib/search/search-text.ts 的 splitSearchTerms）。差别只剩实现
 * 与排序：本函数是子串匹配、不依赖检索索引、不改变列表的截止日期排序 —— 检索服务不可用
 * 时首页筛选照样可用；搜索页走索引（中文按词切分、英文前缀匹配、按相关度排序，并额外
 * 匹配 AI 摘要文本）。此前生产 Meilisearch 默认会把对不上的词丢掉，同一个查询两条路径
 * 给出两种答案（线上实测 `医疗保障 不存在的词xyz`：搜索页 4 条、首页 0 条）。
 */
function keywordCondition(keyword: string) {
  const terms = splitSearchTerms(keyword);
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
/**
 * 公示期天数表达式（截止 − 发布，按日历日）。
 *
 * 这是本项目里**唯一**一处按驱动分支的 SQL：桶边界是派生值，而双方言交集里没有
 * 可移植的天数差函数（SQLite 只有 julianday，PostgreSQL 直接对 date 相减）。
 * 取舍：宁可写这一处显式分支，也不新增一列存储值 —— 新增列要给存量条目回填，
 * 还要让每条入库路径都维护它（issue #30 的教训：多一个需要维护的字段，就多一处
 * 会与真相脱节的地方）。
 *
 * 两侧都先把字符串截到日期部分（substr 1..10）：与统计页应用层的日历日差口径
 * 完全一致，带时分的时间戳不会造成跨界漂移（线上实测两个日期列 100% 是
 * YYYY-MM-DD，这层截断是保险）。任一日期为空 → 表达式为 NULL → 该行不被任何桶
 * 选中，与「缺日期不参与分布」同一口径。
 */
function periodDaysExpr() {
  return currentDriver() === 'postgres'
    ? sql`(substr(${notices.deadlineAt}, 1, 10)::date - substr(${notices.publishedAt}, 1, 10)::date)`
    : sql`(julianday(substr(${notices.deadlineAt}, 1, 10)) - julianday(substr(${notices.publishedAt}, 1, 10)))`;
}

/** 桶条件：由 `PERIOD_BUCKETS` 的 min/max 推导，边界只定义一处。 */
function periodBucketCondition(key: PeriodBucketKey) {
  const bucket = PERIOD_BUCKETS.find((candidate) => candidate.key === key);
  if (bucket === undefined) throw new Error(`未知的公示期桶：${key}`);
  const days = periodDaysExpr();
  const parts = [];
  if (bucket.minDays !== null) parts.push(sql`${days} >= ${bucket.minDays}`);
  if (bucket.maxDays !== null) parts.push(sql`${days} <= ${bucket.maxDays}`);
  return and(...parts);
}

/**
 * 「还没截止」的 SQL 判据 —— 全站只有这一份。
 *
 * 三处用它，**必须**同源，否则页面上的数字和顺序会互相打架：
 * 1. `?open=1` 的 WHERE（issue #62）；
 * 2. 统计页「未截止」列与来源下拉里那个 `openCount`（issue #65）——
 *    「点进去的条数 = 表格上的数字」这条不变式（issue #36）就压在这份共用上；
 * 3. **默认排序的第一档**（issue #79，2026-09-26 起）：头屏不能排满页面自己标着
 *    「已截止」的条目，见 `aggregationOrder()`。
 *
 * 按**展示口径**判，与页面上的徽标同源（issue #43 的那件事）：库内 status 是抓取时
 * 推导的，刚过截止的条目在下一轮抓取前仍写着 open。只看未截止的人若拿到那条，
 * 看到的徽标却是「已截止」—— 筛选器在说谎。
 * 截止日为空的条目留下：它没有"已过"的截止日，`effectiveStatus` 也判它 open。
 *
 * 收成函数而不是常量：`siteDateIso(new Date())` 必须**每次查询现算**（进程长期驻留，
 * 提成模块级常量等于把"今天"冻结在启动那一刻）。排序那一档尤其容易踩这个坑。
 */
function stillOpen() {
  return and(
    eq(notices.status, 'open'),
    or(
      isNull(notices.deadlineAt),
      sql`substr(${notices.deadlineAt}, 1, 10) >= ${siteDateIso(new Date())}`,
    ),
  );
}

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
    //
    // leadAgencyOnly（issue #36）把口径收紧到**牵头机关**：agency_keys 是
    // 「|牵头|参与…|」，牵头机关即第一个竖线段，故模式串是 `|X|%` 而非 `%|X|%`。
    // 统计页「各部门公示量」按牵头机关归并（联合发文只记一次），钻取链接必须带
    // 这个模式才能做到「点进去的条数 = 表格上的数字」。
    //
    // 机关名里的 % / _ 同样按字面处理（与 issue #33 的关键词一致）：不转义的话
    // `?agency=%` 会命中所有联合发文行。
    const agencyPattern = `|${likeLiteral(options.agency)}|`;
    conditions.push(
      or(
        eq(notices.agency, options.agency),
        sql`${notices.agencyKeys} like ${options.leadAgencyOnly ? `${agencyPattern}%` : `%${agencyPattern}%`} escape '\\'`,
      ),
    );
  }
  if (options.periodBucket) {
    conditions.push(periodBucketCondition(options.periodBucket));
  }
  // 发布月份区间：published_at 是 ISO 日期字符串，取前 7 位即月份，与统计页聚合
  // 同口径（stats.ts 用 substr(published_at, 1, 7)）。字符串比较在两种方言下都按
  // 字节序比较 YYYY-MM，等价于月份先后 —— 不需要任何日期函数。
  // 任一端缺省即只约束另一端；published_at 为空的行不满足比较 → 与趋势表
  // 「缺发布日期不计入」同一口径。
  if (options.publishedFromMonth) {
    conditions.push(sql`substr(${notices.publishedAt}, 1, 7) >= ${options.publishedFromMonth}`);
  }
  if (options.publishedToMonth) {
    conditions.push(sql`substr(${notices.publishedAt}, 1, 7) <= ${options.publishedToMonth}`);
  }
  if (options.keyword) {
    const keyword = keywordCondition(options.keyword);
    if (keyword) conditions.push(keyword);
  }
  if (options.sourceId) {
    conditions.push(eq(notices.sourceId, options.sourceId));
  }
  if (options.openOnly) {
    conditions.push(stillOpen());
  }
  if (options.firstSeenWithinDays !== undefined) {
    // 同形状的 UTC ISO 字符串按字节序比较 = 按时间先后比较；下界形状的出处见
    // lib/notice-recency.ts 的 recencyCutoffIso。first_seen_at 为 NULL 的存量行
    // 不满足比较（NULL 在任何比较里都不成立）→ 天然被排除，与角标同一判定。
    conditions.push(
      gte(notices.firstSeenAt, recencyCutoffIso(new Date(), options.firstSeenWithinDays)),
    );
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
    .orderBy(...orderFor(options.sort))
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
 * 按来源渠道聚合的收录面（issue #65）：统计页「各来源收录量」的表 + 首页来源下拉。
 *
 * 为什么值得单列一列「最近新收录」：源健康（issue #58 的 `consecutive_failures`）只看
 * 「这一轮抓取有没有报错」，而**一个源可以天天成功却连续几周一条新的都不送**
 * （源站改版、选择器失效、栏目换址）。那种故障在健康看板里是绿的。`first_seen_at`
 * （#60 第 3 刀加的列）是这里唯一能揭穿它的判据。
 *
 * 登记表里有、但一条都没收录到的源**也要出现在结果里**（count 0）—— 那正是要看得见的情形。
 * 反过来，条目引用了登记表里没有的源（#58 清掉的 `govcn` 那类死行）时 `registered=false`，
 * 名字回落到 ID，让差额在表上看得见而不是被静默归并（issue #46 的同一件事）。
 */
export interface NoticeSourceFacet {
  id: string;
  /** 登记表里的名字；未登记的源回落到 ID */
  name: string;
  /** false = 条目引用了登记表里没有的源 */
  registered: boolean;
  count: number;
  /** 未截止条数，判据与 `?open=1` 同一份 `stillOpen()`（点进去的条数 = 表格数字） */
  openCount: number;
  /** 该源最近一次新收录条目的 `first_seen_at`；一条都没有时为 null */
  lastFirstSeenAt: string | null;
}

export async function listNoticeSourceFacets(): Promise<NoticeSourceFacet[]> {
  const db = await getDb();
  const [grouped, registered] = await Promise.all([
    db
      .select({
        id: notices.sourceId,
        count: sql<number>`count(*)`,
        openCount: sql<number>`sum(case when ${stillOpen()} then 1 else 0 end)`,
        lastFirstSeenAt: sql<string | null>`max(${notices.firstSeenAt})`,
      })
      .from(notices)
      .groupBy(notices.sourceId),
    db.select({ id: sources.id, name: sources.name }).from(sources),
  ]);
  const names = new Map(registered.map((row) => [row.id, row.name]));
  const facets = new Map<string, NoticeSourceFacet>();
  for (const row of registered) {
    facets.set(row.id, {
      id: row.id,
      name: row.name,
      registered: true,
      count: 0,
      openCount: 0,
      lastFirstSeenAt: null,
    });
  }
  for (const row of grouped) {
    facets.set(row.id, {
      id: row.id,
      name: names.get(row.id) ?? row.id,
      registered: names.has(row.id),
      count: Number(row.count),
      openCount: Number(row.openCount ?? 0),
      lastFirstSeenAt: row.lastFirstSeenAt ?? null,
    });
  }
  return [...facets.values()].sort(
    (a, b) => b.count - a.count || a.id.localeCompare(b.id),
  );
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
  // 体裁（issue #76）：入库时先按标题 + 附件名判一次，摘要管线据此选模板。
  // 附件正文那一路更强的证据要等抽取任务，由 markNoticeGenreFromAttachments 补上来。
  const genre = deriveNoticeGenre({
    title: input.title,
    attachmentNames: input.attachments.map((attachment) => attachment.name),
  });
  const existing = await db
    .select({
      id: notices.id,
      title: notices.title,
      agency: notices.agency,
      genre: notices.genre,
      genreBasis: notices.genreBasis,
      genreEvidence: notices.genreEvidence,
    })
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
        // 弱证据不许覆盖强证据：抽取任务可能已把这条升级成正文级的修正案判定，
        // 无条件重写会让两个 job 来回拉扯，读者看到的摘要形态跟着抖。
        ...(genreDecisionWins(
          genre.evidence,
          existing[0].genreEvidence as GenreEvidenceKind | null | undefined,
        )
          ? { genre: genre.genre, genreBasis: genre.basis, genreEvidence: genre.evidence }
          : {}),
        // first_seen_at 刻意不在更新分支里写：它是"这条什么时候第一次进库"，
        // 更新时改写它就等于把老条目重新变成"新公示"，通知会天天重发。
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
    genre: genre.genre,
    genreBasis: genre.basis,
    genreEvidence: genre.evidence,
    // 首次收录时间：只在这一行被创建时写入（issue #60 第 3 刀）
    firstSeenAt: input.fetchedAt,
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
    .values({ noticeId: id, clickDate: siteDateIso(new Date()), clicks: 1 })
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
    firstSeenAt: row.firstSeenAt,
    genre: row.genre as NoticeRecord['genre'],
    genreBasis: row.genreBasis,
    genreEvidence: row.genreEvidence as NoticeRecord['genreEvidence'],
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

/**
 * 存量体裁回填（issue #76）。判据与生产路径完全同一份（`deriveNoticeGenre`），
 * 这里只负责"取数 + 是否写库"。
 *
 * 一条刻意的不对称：**已判定过的条目只有在新证据更强时才改写**。否则回填脚本每跑一次
 * 就会把按附件正文升级成"修正案"的条目降回按标题判的结果，摘要模板天天抖。
 *
 * 而这条守卫会让**改词表**这类修复彻底落不了地（issue #79 实测）：收窄词表之后，
 * 那 22 条靠正文「现行」判进来的条目重算出来一律是"标题级证据"（rank 1），
 * 比存着的 `attachment_text`（rank 3）弱 ⇒ 全走 `skipped`，一条都改不动，
 * 5 条本该变成新案的条目会继续挂着"修正案"角标与修正案模板。
 *
 * 所以 `force: true` 是给"输入变了"这种情形的逃生门 —— 不是绕过判据，而是承认
 * **强弱只是同一套词表内部的相对关系**：词表本身换了，旧的"强证据"就只是一条过期结论。
 * 上面的注释里"标题真的变了由调用方显式重算"说的也是这件事，`force` 就是那个显式。
 * 用它时要看清报告：`samples` 会逐条列出 from → to 与新的依据，改动面是可核对的。
 * （`force` 仍然尊重"算出来与存量逐字相同就不写"这一条，所以重复跑是幂等的。）
 */
export async function backfillNoticeGenres(options: { apply: boolean; force?: boolean }): Promise<{
  total: number;
  changed: number;
  skipped: number;
  unknown: number;
  byGenre: Record<string, number>;
  samples: { id: string; from: string | null; to: string; basis: string; title: string }[];
}> {
  const db = await getDb();
  const rows = await db
    .select({
      id: notices.id,
      title: notices.title,
      attachmentsJson: notices.attachmentsJson,
      genre: notices.genre,
      genreBasis: notices.genreBasis,
      genreEvidence: notices.genreEvidence,
    })
    .from(notices);
  const files = await db
    .select({
      noticeId: noticeAttachments.noticeId,
      name: noticeAttachments.name,
      extractedText: noticeAttachments.extractedText,
    })
    .from(noticeAttachments);
  const byNotice = new Map<string, { names: string[]; texts: string[] }>();
  for (const file of files) {
    const bucket = byNotice.get(file.noticeId) ?? { names: [], texts: [] };
    bucket.names.push(file.name ?? '');
    bucket.texts.push(file.extractedText ?? '');
    byNotice.set(file.noticeId, bucket);
  }
  const byGenre: Record<string, number> = {};
  const samples: { id: string; from: string | null; to: string; basis: string; title: string }[] = [];
  let changed = 0;
  let skipped = 0;
  for (const row of rows) {
    const bucket = byNotice.get(row.id) ?? { names: [], texts: [] };
    const decision = deriveNoticeGenre({
      title: row.title,
      attachmentNames: bucket.names,
      attachmentText: bucket.texts.join(' '),
    });
    byGenre[decision.genre] = (byGenre[decision.genre] ?? 0) + 1;
    const storedEvidence = row.genreEvidence as GenreEvidenceKind | null;
    if (!options.force && row.genre !== null && !genreDecisionWins(decision.evidence, storedEvidence)) {
      skipped += 1;
      continue;
    }
    if (row.genre === decision.genre && row.genreBasis === decision.basis) continue;
    changed += 1;
    if (samples.length < 400) {
      samples.push({ id: row.id, from: row.genre, to: decision.genre, basis: decision.basis, title: row.title });
    }
    if (options.apply) {
      await db
        .update(notices)
        .set({ genre: decision.genre, genreBasis: decision.basis, genreEvidence: decision.evidence })
        .where(eq(notices.id, row.id));
    }
  }
  return {
    total: rows.length,
    changed,
    skipped,
    unknown: byGenre.unknown ?? 0,
    byGenre,
    samples,
  };
}
