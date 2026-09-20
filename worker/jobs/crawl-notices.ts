import type { NoticeStatus } from '../../src/db/types.ts';
import { sendTaskFailureAlert } from '../../src/lib/alerts.ts';
import { noticeIdForUrl } from '../../src/lib/notice-id.ts';
import { upsertNotice } from '../../src/db/repo/notices.ts';
import { getSourceById, recordSourceFailure, upsertSource } from '../../src/db/repo/sources.ts';
import { syncNoticesToSearchIndex } from '../../src/lib/search/sync.ts';
import { localDateIso } from '../../src/lib/dates.ts';
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
 * 领域标签（issue #9）：入库路径（upsertNotice）自动按关键词规则打标；
 * 适配器可通过 NormalizedNotice.categoryTags 直接给出权威领域（优先采用）。
 */

const FETCH_TIMEOUT_MS = 15_000;
/**
 * 详情抓取之间的礼貌间隔（issue #14）：三源都是政府站点，串行连发上百个详情
 * 请求容易被 WAF 判定为爬虫而封 IP，整条数据管线会直接断掉。
 * 取值依据：单轮最大约 100 条 × 400ms ≈ 40s 额外耗时（可接受，不需要并发），
 * 400ms 明显高于连续机器请求的间隔、又远低于人工浏览节奏。
 */
const DETAIL_FETCH_INTERVAL_MS = 400;
// HTTP 头只能是 ByteString，UA 必须保持 ASCII
const USER_AGENT =
  'zhurenweng-crawler/0.1 (+https://github.com/omeyb110674401-rgb/zhurenweng; gov-notice aggregator)';

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

/** 状态推导：截止日期早于今天 → 已截止；无截止日期默认征求意见中。 */
function deriveStatus(deadlineAt: string | null, now: Date): NoticeStatus {
  if (!deadlineAt) return 'open';
  return deadlineAt < localDateIso(now) ? 'closed' : 'open';
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
  };
}

/**
 * 抓取文本（HTML 或接口 JSON 原文）。options 为适配器声明的源级处置：
 * - 默认：普通 fetch，非 2xx 视为失败；
 * - cookieChallenge（司法部站点实测）：首个响应是 3xx + Set-Cookie 且 Location 指回
 *   同一地址的 WAF 挑战，必须带 cookie 重放一次；用 redirect: 'manual' 接住挑战，
 *   避免 fetch 自动跟随重定向时陷入自我循环。
 */
async function fetchText(url: string, options?: SourceFetchOptions): Promise<string> {
  const headers = { 'user-agent': USER_AGENT };

  if (!options?.cookieChallenge) {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.text();
  }

  const challenge = await fetch(url, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const cookies = challenge.headers
    .getSetCookie()
    .map((value) => value.split(';')[0] ?? '')
    .filter((value) => value.length > 0)
    .join('; ');
  if (cookies.length === 0) {
    if (!challenge.ok) {
      throw new Error(`HTTP ${challenge.status}（WAF 未下发 cookie）`);
    }
    return challenge.text();
  }

  const response = await fetch(url, {
    headers: { ...headers, cookie: cookies },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}（携带 WAF cookie 重放后仍失败）`);
  }
  return response.text();
}

/** 抓取并解析详情页；单条详情失败只降级保留列表层数据，不中断整轮抓取。 */
async function enrichWithDetail(
  adapter: SourceAdapter,
  notice: NormalizedNotice,
  ctx: JobContext,
): Promise<NormalizedNotice> {
  if (!adapter.parseDetail) return notice;
  // 详情内容默认取原文 URL；前端渲染型详情页由适配器指向数据接口（见 SourceAdapter）
  const contentUrl = adapter.detailContentUrl?.(notice) ?? notice.url;
  try {
    const detailHtml = await fetchText(contentUrl, adapter.fetch);
    // 第二参始终传人工页 URL：详情解析器用它解析相对链接（附件等）
    const detail = await adapter.parseDetail(detailHtml, notice.url);
    return detail ? mergeDetail(notice, detail) : notice;
  } catch (error) {
    ctx.logger(
      `详情页抓取失败（保留列表层数据）url=${contentUrl}：${errorMessage(error)}`,
    );
    return notice;
  }
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

        const listHtml = await fetchText(listUrl);
        const listItems = await adapter.parseList(listHtml, listUrl);

        let inserted = 0;
        let updated = 0;
        // 本轮新增 / 更新的条目 id：入库与更新时同步检索索引（issue #8）
        const changedNoticeIds: string[] = [];
        for (const notice of listItems) {
          const normalized = await enrichWithDetail(adapter, notice, ctx);
          // 对源站礼貌、避免触发限流（issue #14）：三源都是政府站点，串行连发
          // 上百个详情请求容易被 WAF 判定为爬虫而封 IP，整条数据管线会直接断掉。
          // 取值依据：单轮最大约 100 条 × 400ms ≈ 40s 额外耗时（可接受），
          // 400ms 低于任何人工浏览节奏、又明显高于连续机器请求的间隔。
          await sleep(DETAIL_FETCH_INTERVAL_MS);
          const id = noticeIdForUrl(normalized.url);
          const result = await upsertNotice({
            id,
            sourceId: adapter.id,
            title: normalized.title,
            agency: normalized.agency,
            url: normalized.url,
            publishedAt: normalized.publishedAt,
            deadlineAt: normalized.deadlineAt,
            status: deriveStatus(normalized.deadlineAt, now),
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
        }

        await upsertSource({
          id: adapter.id,
          name: adapter.name,
          adapterType: adapter.id,
          healthy: true,
          lastSuccessAt: now.toISOString(),
        });
        ctx.logger(
          `源 ${adapter.id} 抓取完成：列表 ${listItems.length} 条，新增 ${inserted}，更新 ${updated}`,
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
