import type { NoticeStatus } from '../../src/db/types.ts';
import { sendTaskFailureAlert } from '../../src/lib/alerts.ts';
import { noticeIdForUrl } from '../../src/lib/notice-id.ts';
import { getNoticeById, upsertNotice } from '../../src/db/repo/notices.ts';
import { getSourceById, recordSourceFailure, upsertSource } from '../../src/db/repo/sources.ts';
import { syncNoticesToSearchIndex } from '../../src/lib/search/sync.ts';
import { siteDateIso } from '../../src/lib/dates.ts';
import { isSourceDegraded } from '../../src/lib/source-health.ts';
import { isAllowedCrawlUrl } from '../../src/lib/net-guard.ts';
import { CRAWLER_USER_AGENT } from '../../src/lib/site-identity.ts';
import {
  sourceAdapters,
  type NormalizedNotice,
  type ParsedDetail,
  type SourceAdapter,
  type SourceFetchOptions,
} from '../../src/sources/registry.ts';
import type { Job, JobContext } from '../registry.ts';

/**
 * 抓取任务（issue #3）：遍历源适配器注册表，抓取列表页 → 解析标准化条目 →
 * 逐条抓取详情页补充正文 / 截止日期 / 附件 → 以原文 URL 为唯一键幂等入库。
 *
 * 抓取来源：生产环境使用各适配器的生产 listUrl；设置 SOURCES_FIXTURE_BASE 后
 * 重写为 `<base>/<源ID>/<listFixturePath ?? list.html>`，E2E 借此把全部源指向
 * 本地 fixture 源站（ADR-0001：测试不访问真实源站）。列表本身是接口的源
 * （如全国人大网的 JSON 接口）用 list.json 承载快照。
 * 每日调度由 worker 主循环的 WORKER_INTERVAL_MS 控制（生产 compose 设为每日），
 * WORKER_ONCE=1 可单轮运行。
 *
 * 源级抓取处置（issue #14）：适配器可通过 `fetch` 声明本站特有的传输要求
 * （目前只有司法部站点的 WAF cookie 挑战，见 SourceFetchOptions）；详情内容
 * 默认取条目原文 URL，前端渲染型详情页由适配器的 detailContentUrl 指向数据接口，
 * 但入库唯一键与用户可见的「官方原文」始终是原文 URL。
 *
 * 健康与告警（issue #12）：失败登记源的错误列（健康看板展示）并发送告警邮件
 * （收件人 ALERT_EMAIL；同日 × 任务 × 源去重）；管理后台停用的源整轮跳过。
 *
 * 失败降级（issue #30）：单条详情抓取失败只记日志、不中断整轮，且**不覆盖已入库的
 * 详情层字段**（正文 / 截止日期 / 发布日期 / 附件）—— 入库是整行覆盖写，一次网络抖动
 * 会把上一轮抓到的正文抹成 null，并让已截止条目因截止日期丢失翻回「征求意见中」。
 * 取舍见 preserveStoredDetail。
 *
 * 领域标签（issue #9）：入库路径（upsertNotice）自动按关键词规则打标；
 * 适配器可通过 NormalizedNotice.categoryTags 直接给出权威领域（优先采用）。
 *
 * 出网守卫（issue #52）：详情 URL 由源站列表 HTML 解析而来，重定向目标同样来自源站 ——
 * 每一跳都先过 `isAllowedCrawlUrl`（拒绝内网 / 本机 / 元数据地址，口径见 net-guard.ts），
 * 并限制响应体大小。这是抓取侧唯一的信任边界：源站被挂马不该变成打内网的跳板。
 */

const FETCH_TIMEOUT_MS = 15_000;
/**
 * 重定向的最大跟随跳数（防异常站点造成无限跟随）。**所有源**共用 —— 从前只有
 * cookieChallenge 源手动跟随，其余交给 fetch 自动跟（≤20 跳、且不看目标），
 * 那正是 issue #52 的出网缺口：每一跳都要过守卫，就只能自己跟。
 */
const MAX_REDIRECT_HOPS = 5;
/**
 * 响应体上限（issue #52）：此前只有 15s 超时，没有大小上限 —— 源站异常（或被挂马）
 * 持续输出大流量时，15 秒内就能把 worker 内存打满，而 worker 同时跑抓取 / 摘要 /
 * 提醒，OOM 会中断整条数据管线。政府页面实测都在几百 KB 量级，4 MiB 有十倍余量。
 */
const MAX_FETCH_BYTES = 4 * 1024 * 1024;
/**
 * 详情抓取之间的礼貌间隔（issue #14）：三源都是政府站点，串行连发上百个详情
 * 请求容易被 WAF 判定为爬虫而封 IP，整条数据管线会直接断掉。
 * 取值依据：单轮最大约 100 条 × 400ms ≈ 40s 额外耗时（可接受，不需要并发），
 * 400ms 明显高于连续机器请求的间隔、又远低于人工浏览节奏。
 */
const DETAIL_FETCH_INTERVAL_MS = 400;
/**
 * 爬虫 UA：与审计 / 快照脚本（scripts/*.mjs）共用同一份常量。
 *
 * 为什么收成一处：那串 UA 原先在 6 个文件里各写一遍，改一处漏一处就会让源站
 * 收到指向死主机的联系地址 —— 2026-09-21 就是这么发生的（UA 里还写着已 404 的
 * 仓库地址）。语义（为什么联系地址指本站、为什么是常量而非 SITE_URL）见
 * src/lib/site-identity.ts。
 */
const USER_AGENT = CRAWLER_USER_AGENT;

/** 两行小工具：等待若干毫秒（礼貌间隔，见 DETAIL_FETCH_INTERVAL_MS）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 解析某适配器本次运行使用的列表页 URL（环境变量可重写为 fixture 源站）。 */
export function resolveListUrl(adapter: SourceAdapter): string {
  const fixtureBase = process.env.SOURCES_FIXTURE_BASE;
  if (fixtureBase) {
    const listFile = adapter.listFixturePath ?? 'list.html';
    return `${fixtureBase.replace(/\/+$/, '')}/${adapter.id}/${listFile}`;
  }
  return adapter.listUrl;
}

/**
 * 条目主键：原文 URL 的 SHA-256 前缀。确定性强 —— 重复抓取、跨库重建、
 * 手动补录（issue #12）都命中同一 id，/go/<id> 的点击计数因此能稳定累计。
 * 实现见 src/lib/notice-id.ts（与手动补录共用）。
 */

/**
 * 状态推导，按可信度取三级：
 * 1. **截止日期**（最精确的事实）：早于今天 → 已截止，否则征求意见中；
 * 2. **源自身标注**（issue #18）：交通运输部 / 教育部 / 市场监管总局等栏目直接在
 *    标题或状态列标注「进行中 / 已结束」，截止日期解析不到时采用它 ——
 *    比默认「征求意见中」准确（否则跨域的民航局条目、详情缺截止句的条目
 *    会全部被误判为进行中）；
 * 3. 兜底「征求意见中」（与 M1 行为一致）。
 *
 * 截止日期优先于源标注：源标注是抓取时刻的快照，日期是事实，两者冲突时以日期为准。
 */
function deriveStatus(
  deadlineAt: string | null,
  adapterStatus: NoticeStatus | undefined,
  now: Date,
): NoticeStatus {
  if (deadlineAt) return deadlineAt < siteDateIso(now) ? 'closed' : 'open';
  return adapterStatus ?? 'open';
}

function mergeDetail(notice: NormalizedNotice, detail: ParsedDetail): NormalizedNotice {
  return {
    title: detail.title ?? notice.title,
    agency: detail.agency ?? notice.agency,
    url: notice.url,
    publishedAt: detail.publishedAt ?? notice.publishedAt,
    deadlineAt: detail.deadlineAt ?? notice.deadlineAt,
    bodyText: detail.bodyText ?? notice.bodyText,
    attachments: detail.attachments ?? notice.attachments,
    categoryTags: detail.categoryTags ?? notice.categoryTags,
    status: detail.status ?? notice.status,
  };
}

/**
 * 本次运行显式放行的抓取 origin：E2E 的 fixture 源站跑在 `http://127.0.0.1:<port>`
 * 上（环回地址），守卫默认会拦掉它 —— 由 SOURCES_FIXTURE_BASE 推导后放行。
 * 生产不设该变量 → 返回空数组 → 所有内网 / 本机目标一律拒绝。
 *
 * `SOURCES_FIXTURE_EXTRA_ORIGINS`（逗号分隔）同样是**只有测试才设**的：有的链路要用
 * 两台 fixture 源站才能扮演（issue #57 的「附件子域回 403、主域上是同一份文件」），
 * 而单个 SOURCES_FIXTURE_BASE 只放行一个 origin。
 */
function allowedCrawlOrigins(): string[] {
  const listed = [
    process.env.SOURCES_FIXTURE_BASE ?? '',
    ...(process.env.SOURCES_FIXTURE_EXTRA_ORIGINS ?? '').split(','),
  ];
  const origins: string[] = [];
  for (const entry of listed) {
    const value = entry.trim();
    if (value === '') continue;
    try {
      const { origin } = new URL(value);
      if (!origins.includes(origin)) origins.push(origin);
    } catch {
      // 某一项写坏就跳过它：其余项仍要放行，但绝不因解析失败而放宽成「全部放行」
    }
  }
  return origins;
}

/** 3xx：需要跟随的重定向（WAF 挑战也是一种 3xx，但由调用方按 Set-Cookie 区分）。 */
function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

/** 丢弃响应体（重定向 / 超限时调用），失败不掩盖原始错误。 */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** Set-Cookie 的值部分（`k=v`），多枚以 `; ` 连接。 */
function cookieHeaderOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0] ?? '')
    .filter((value) => value.length > 0)
    .join('; ');
}

/** 把 Location 解析成绝对地址（相对地址按当前地址解析）。 */
function absoluteLocation(location: string, current: string): string {
  try {
    return new URL(location, current).toString();
  } catch {
    throw new Error(`重定向 Location 无法解析：${location}`);
  }
}

/**
 * 带守卫的单次请求（**不自动跟随重定向**，见 MAX_REDIRECT_HOPS）。
 *
 * 出网守卫（issue #52）：抓取器请求的是第三方页面给出的地址，被挂马 / 改版的源站
 * 可以用一个指向 `169.254.169.254` 或内网主机的链接指挥 worker 去请求。判定口径与
 * 为什么不做同源白名单见 src/lib/net-guard.ts。
 */
async function guardedFetch(
  url: string,
  allowedOrigins: readonly string[],
  cookie: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const verdict = isAllowedCrawlUrl(url, allowedOrigins);
  if (!verdict.ok) {
    throw new Error(`出网守卫拒绝（${verdict.reason}）：${url}`);
  }
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, ...extraHeaders };
  if (cookie.length > 0) headers.cookie = cookie;
  return fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/**
 * 读取响应体为字节，超过 maxBytes 即中止（先看 content-length 快速失败，
 * 再流式计数兜住「不报长度 / 谎报长度」的响应）。
 */
export async function readCappedBuffer(response: Response, maxBytes: number): Promise<Uint8Array> {
  const limitText = `${Math.round(maxBytes / 1024 / 1024)} MiB`;
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(response);
    throw new Error(`响应体超过 ${limitText} 上限（content-length=${declared}）`);
  }
  if (response.body === null) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`响应体超过 ${limitText} 上限（已读取 ${total} 字节）`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** 读取响应体为文本，上限见 MAX_FETCH_BYTES。 */
async function readCappedText(response: Response): Promise<string> {
  return Buffer.from(await readCappedBuffer(response, MAX_FETCH_BYTES)).toString('utf8');
}

export interface CrawlRequest {
  /** 适配器声明的源级传输处置（cookieChallenge） */
  fetchOptions?: SourceFetchOptions;
  /** 额外请求头：附件请求要带 referer 与 range */
  headers?: Record<string, string>;
  /**
   * 命中这些状态码时**原样返回响应**而不是抛错。
   *
   * 附件下载需要它：401/403/404 是「源站拒绝了我们」这个**结论**，要写进库里支撑
   * 详情页「为什么读不到」的说明；当成异常抛出就会被记成抓取失败（issue #57）。
   */
  returnForStatus?: (status: number) => boolean;
}

/**
 * 走完「守卫 + 手动跟随重定向 + WAF cookie」的整趟旅程，返回**最终响应**。
 * 调用方负责消费响应体（readCappedText / readCappedBuffer / discard）。
 *
 * 两种 3xx 必须区分（issue #14 上线后实测踩到）：**带 Set-Cookie 的才是 WAF 挑战**；
 * 不带 Set-Cookie 的是普通重定向（司法部列表里的详情链接写成 http://，服务端 302 到
 * https 且无 cookie），必须跟着走 —— 否则整源详情静默退化为列表层数据（截断标题、
 * 无正文、无截止日期），且日志只留下一条「WAF 未下发 cookie」。
 *
 * 两条路径都**手动跟随重定向**（issue #52）：每一跳都过出网守卫、都受跳数上限约束。
 * WAF cookie 只在**同主机**时携带 —— 它由该主机下发，不该跟着重定向送给别的站点
 * （同主机的 http→https 升级仍带，那是司法部详情的真实路径）。
 */
export async function crawlFetch(url: string, request: CrawlRequest = {}): Promise<Response> {
  const allowedOrigins = allowedCrawlOrigins();
  let current = url;
  let cookies = '';
  let cookieHost: string | null = null;
  let hops = 0;

  for (;;) {
    const cookie = cookieHost !== null && sameHost(current, cookieHost) ? cookies : '';
    const response = await guardedFetch(current, allowedOrigins, cookie, request.headers);
    // 只在「还没拿到 cookie」时接受挑战，否则源站每次都下发 Set-Cookie 会成死循环
    const granted = cookies.length === 0 ? cookieHeaderOf(response) : '';

    if (granted.length > 0) {
      // WAF 挑战：带 cookie 重放同一地址（挑战不是重定向，不计跳数）
      await discard(response);
      cookies = granted;
      cookieHost = current;
      continue;
    }

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get('location');
      await discard(response);
      if (!location) throw new Error(`HTTP ${response.status}（重定向缺少 Location）`);
      if (hops >= MAX_REDIRECT_HOPS) {
        throw new Error(`重定向次数超过 ${MAX_REDIRECT_HOPS} 次：${url}`);
      }
      hops += 1;
      current = absoluteLocation(location, current);
      continue;
    }

    if (!response.ok && request.returnForStatus?.(response.status) === true) return response;

    if (!response.ok) {
      throw new Error(
        request.fetchOptions?.cookieChallenge && cookies.length === 0
          ? `HTTP ${response.status}（WAF 未下发 cookie）`
          : cookies.length > 0
            ? `HTTP ${response.status}（携带 WAF cookie 重放后仍失败）`
            : `HTTP ${response.status}`,
      );
    }
    return response;
  }
}

/** 抓取文本（HTML 或接口 JSON 原文），处置见 crawlFetch。 */
async function fetchText(url: string, options?: SourceFetchOptions): Promise<string> {
  return readCappedText(await crawlFetch(url, { fetchOptions: options }));
}

/**
 * 详情内容地址的链式跳转上限（issue #20）：国家发展改革委实测 2 跳
 * （access-url 接口 → 正文接口）；留出余量，但绝不能无限跟随 ——
 * 适配器若因为页面改版而始终返回下一跳，整轮抓取会被拖死。
 */
const MAX_DETAIL_HOPS = 4;
/**
 * 取详情内容 body：先取首跳地址，再按适配器的 resolveDetailUrl 逐跳跟随，
 * 直到适配器返回 null（「当前 body 即详情内容」）或到达跳数上限。
 * 每一跳的请求都由抓取层发出（源级传输处置 / UA / 超时 / fixture 重写集中在此）。
 */
async function fetchDetailBody(adapter: SourceAdapter, firstUrl: string): Promise<string> {
  let url = firstUrl;
  let body = await fetchText(url, adapter.fetch);
  if (!adapter.resolveDetailUrl) return body;

  for (let hop = 0; hop < MAX_DETAIL_HOPS; hop += 1) {
    const next = await adapter.resolveDetailUrl(body, url);
    if (!next) return body;
    url = next;
    body = await fetchText(url, adapter.fetch);
  }
  throw new Error(`详情地址链式跳转超过 ${MAX_DETAIL_HOPS} 跳仍未取到正文：${firstUrl}`);
}

/**
 * 详情抓取结果：`detailLoaded=false` 表示这一轮**没拿到详情内容**，两种情形都算 ——
 * 传输失败（fetch 抛错）与解析落空（parseDetail 返回 null，站点改版时会这样）。
 * 此时列表层数据仍然有效，但详情层字段必须沿用已入库的值（见 preserveStoredDetail）。
 */
interface DetailEnrichment {
  notice: NormalizedNotice;
  detailLoaded: boolean;
}

/** 抓取并解析详情页；单条详情失败只降级、不中断整轮抓取。 */
async function enrichWithDetail(
  adapter: SourceAdapter,
  notice: NormalizedNotice,
  ctx: JobContext,
): Promise<DetailEnrichment> {
  // 没有详情解析器的源没有「详情层」，列表层就是全部（不涉及沿用旧值）
  if (!adapter.parseDetail) return { notice, detailLoaded: true };
  // 详情内容默认取原文 URL；前端渲染型详情页由适配器指向数据接口（见 SourceAdapter）
  const contentUrl = adapter.detailContentUrl?.(notice) ?? notice.url;
  try {
    const detailBody = await fetchDetailBody(adapter, contentUrl);
    // 第二参始终传人工页 URL：详情解析器用它解析相对链接（附件等）
    const detail = await adapter.parseDetail(detailBody, notice.url);
    return { notice: detail ? mergeDetail(notice, detail) : notice, detailLoaded: detail !== null };
  } catch (error) {
    ctx.logger(
      `详情页抓取失败（本轮沿用已入库的详情数据）url=${contentUrl}：${errorMessage(error)}`,
    );
    return { notice, detailLoaded: false };
  }
}

/**
 * 详情抓取失败时的字段保全（issue #30）：列表层字段照常刷新，**详情层字段沿用已入库的值**。
 *
 * 为什么必须这么做：`upsertNotice` 是整行覆盖写。一次网络抖动（线上实测：中国民航局
 * 站点从服务器不可达）会把 bodyText / deadlineAt / publishedAt / attachments 全写成
 * null —— 正文、倒计时、附件凭空消失，而且**已截止条目会因为截止日期丢失退回
 * 「征求意见中」**（deriveStatus 在 deadlineAt 为空时用源标注、再兜底 open）。
 * 抓取是每天一轮的常态动作，详情失败是偶发事件，不能让偶发覆盖常态。
 *
 * 只补「本轮拿不到的」：列表层给出值的字段（部分源的列表就带正文 / 截止日期）以本轮为准。
 * 代价：源站若真的删掉了附件，旧附件清单会保留到下一轮详情抓取成功 —— 相比一次抖动
 * 抹掉全部内容，这个方向更安全。
 */
async function preserveStoredDetail(
  id: string,
  notice: NormalizedNotice,
): Promise<NormalizedNotice> {
  // 已入库行读失败（如库连接抖动）不阻断本轮：退回列表层数据，与旧行为一致
  const stored = await getNoticeById(id).catch(() => null);
  if (!stored) return notice;
  return {
    ...notice,
    publishedAt: notice.publishedAt ?? stored.publishedAt,
    deadlineAt: notice.deadlineAt ?? stored.deadlineAt,
    bodyText: notice.bodyText ?? stored.bodyText,
    attachments: notice.attachments.length > 0 ? notice.attachments : stored.attachments,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const crawlNoticesJob: Job = {
  name: 'crawl-notices',
  description: '每日抓取全部源适配器：列表页 + 详情页 → 标准化 → 幂等入库',
  async run(ctx: JobContext): Promise<void> {
    const now = ctx.now();

    for (const adapter of sourceAdapters) {
      const listUrl = resolveListUrl(adapter);
      // 源管理（issue #12）：管理后台停用的源整轮跳过，既不抓取也不计失败
      const registered = await getSourceById(adapter.id).catch(() => null);
      if (registered && !registered.enabled) {
        ctx.logger(`源 ${adapter.id} 已停用，本轮跳过`);
        continue;
      }
      try {
        // 先登记源行（notices.source_id 外键引用 sources.id，必须先于条目入库存在）；
        // 健康状态乐观置为 true，本轮失败再翻回 false。
        await upsertSource({
          id: adapter.id,
          name: adapter.name,
          adapterType: adapter.id,
          healthy: true,
        });

        // 列表同样要走源级处置（司法部站点的 WAF cookie 挑战对列表请求也生效）
        const listHtml = await fetchText(listUrl, adapter.fetch);
        const listItems = await adapter.parseList(listHtml, listUrl);

        let inserted = 0;
        let updated = 0;
        // 逐条失败计数（issue #51）：单条失败被吞掉是为了「一条坏数据不拖垮整源」，
        // 但**吞掉不等于没发生** —— 旧代码在详情解析全落空时照样打印「抓取完成」并把
        // 源标成健康，正文 / 截止日期 / 附件就这么静默烂下去（#30 只解决了「不覆盖」，
        // 没解决「没人知道」）。这两个计数用于本轮的完成日志与源健康判定。
        let detailFailed = 0;
        let upsertFailed = 0;
        // 本轮新增 / 更新的条目 id：入库与更新时同步检索索引（issue #8）
        const changedNoticeIds: string[] = [];
        for (const notice of listItems) {
          const enriched = await enrichWithDetail(adapter, notice, ctx);
          if (!enriched.detailLoaded) detailFailed += 1;
          // 详情没抓到（失败或解析落空）时沿用已入库的详情层字段，避免偶发失败抹掉常态数据
          const normalized = enriched.detailLoaded
            ? enriched.notice
            : await preserveStoredDetail(noticeIdForUrl(enriched.notice.url), enriched.notice);
          // 对源站礼貌、避免触发限流（issue #14）：三源都是政府站点，串行连发
          // 上百个详情请求容易被 WAF 判定为爬虫而封 IP，整条数据管线会直接断掉。
          // 取值依据：单轮最大约 100 条 × 400ms ≈ 40s 额外耗时（可接受），
          // 400ms 低于任何人工浏览节奏、又明显高于连续机器请求的间隔。
          await sleep(DETAIL_FETCH_INTERVAL_MS);
          const id = noticeIdForUrl(normalized.url);
          try {
            const result = await upsertNotice({
              id,
              sourceId: adapter.id,
              title: normalized.title,
              agency: normalized.agency,
              url: normalized.url,
              publishedAt: normalized.publishedAt,
              deadlineAt: normalized.deadlineAt,
              status: deriveStatus(normalized.deadlineAt, normalized.status, now),
              // 领域标签（issue #9）：适配器规则优先（NormalizedNotice.categoryTags），
              // 未提供时不传 —— 入库路径按关键词规则自动打标（与手动补录单一入口）
              categoryTags: normalized.categoryTags,
              bodyText: normalized.bodyText,
              attachments: normalized.attachments,
              fetchedAt: now.toISOString(),
            });
            if (result === 'inserted') {
              inserted += 1;
            } else {
              updated += 1;
            }
            changedNoticeIds.push(id);
          } catch (error) {
            // 单条入库失败只跳过这一条（issue #51）：此前异常冒泡到源级 catch，
            // 该源剩下的条目**全部不写**、源被标成失败并发一封「源抓取失败」告警 ——
            // 一条坏数据连坐整个源，告警里的原因也指错了地方。
            upsertFailed += 1;
            ctx.logger(`源 ${adapter.id} 条目 ${id} 入库失败（跳过该条）：${errorMessage(error)}`);
          }
        }

        // 大面积逐条失败按源级失败处理（issue #51）：标成健康且不告警 = 静默烂掉。
        // 判据（过半且列表不少于 3 条）在 lib/source-health.ts，单测钉死。
        const failedCount = detailFailed + upsertFailed;
        const degraded = isSourceDegraded(listItems.length, failedCount);
        if (degraded) {
          const message =
            `本轮 ${listItems.length} 条里 ${detailFailed} 条详情失败、${upsertFailed} 条入库失败` +
            `（疑似源站改版或库异常，数据可能已停止更新）`;
          await recordSourceFailure({
            id: adapter.id,
            name: adapter.name,
            adapterType: adapter.id,
            error: message,
            now: now.toISOString(),
          }).catch(() => {
            // 健康状态登记失败不掩盖本轮的数据质量事实
          });
          await sendTaskFailureAlert({
            jobName: 'crawl-notices',
            sourceId: adapter.id,
            error: message,
            now,
            log: ctx.logger,
          });
          ctx.logger(`源 ${adapter.id} 数据质量降级：${message}`);
        } else {
          await upsertSource({
            id: adapter.id,
            name: adapter.name,
            adapterType: adapter.id,
            healthy: true,
            lastSuccessAt: now.toISOString(),
          });
        }
        ctx.logger(
          `源 ${adapter.id} 抓取完成：列表 ${listItems.length} 条，新增 ${inserted}，更新 ${updated}` +
            (failedCount > 0 ? `，详情失败 ${detailFailed}，入库失败 ${upsertFailed}` : ''),
        );
        // 索引同步钩子（issue #8）：同步失败只降级记日志，由重建任务兜底，不中断抓取
        try {
          await syncNoticesToSearchIndex(changedNoticeIds, ctx.logger);
        } catch (error) {
          ctx.logger(
            `源 ${adapter.id} 检索索引同步失败（由重建任务兜底）：${errorMessage(error)}`,
          );
        }
      } catch (error) {
        const message = errorMessage(error);
        await recordSourceFailure({
          id: adapter.id,
          name: adapter.name,
          adapterType: adapter.id,
          error: message,
          now: now.toISOString(),
        }).catch(() => {
          // 健康状态登记失败不掩盖原始抓取错误
        });
        // 源健康告警（issue #12）：同日 × 任务 × 源去重，邮件失败不影响本轮
        await sendTaskFailureAlert({
          jobName: 'crawl-notices',
          sourceId: adapter.id,
          error: message,
          now,
          log: ctx.logger,
        });
        ctx.logger(`源 ${adapter.id} 抓取失败（listUrl=${listUrl}）：${message}`);
      }
    }
  },
};
