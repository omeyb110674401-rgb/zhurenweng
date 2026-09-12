import { createHash } from 'node:crypto';
import type { NoticeStatus } from '../../src/db/types.ts';
import { upsertNotice } from '../../src/db/repo/notices.ts';
import { upsertSource } from '../../src/db/repo/sources.ts';
import { localDateIso } from '../../src/lib/dates.ts';
import {
  sourceAdapters,
  type NormalizedNotice,
  type ParsedDetail,
  type SourceAdapter,
} from '../../src/sources/registry.ts';
import type { Job, JobContext } from '../registry.ts';

/**
 * 抓取任务（issue #3）：遍历源适配器注册表，抓取列表页 → 解析标准化条目 →
 * 逐条抓取详情页补充正文 / 截止日期 / 附件 → 以原文 URL 为唯一键幂等入库。
 *
 * 抓取来源：生产环境使用各适配器的生产 listUrl；设置 SOURCES_FIXTURE_BASE 后
 * 重写为 `<base>/<源ID>/list.html`，E2E 借此把全部源指向本地 fixture 源站
 * （ADR-0001：测试不访问真实源站）。每日调度由 worker 主循环的
 * WORKER_INTERVAL_MS 控制（生产 compose 设为每日），WORKER_ONCE=1 可单轮运行。
 */

const FETCH_TIMEOUT_MS = 15_000;
// HTTP 头只能是 ByteString，UA 必须保持 ASCII
const USER_AGENT =
  'zhurenweng-crawler/0.1 (+https://github.com/omeyb110674401-rgb/zhurenweng; gov-notice aggregator)';

/** 解析某适配器本次运行使用的列表页 URL（环境变量可重写为 fixture 源站）。 */
export function resolveListUrl(adapter: SourceAdapter): string {
  const fixtureBase = process.env.SOURCES_FIXTURE_BASE;
  if (fixtureBase) {
    return `${fixtureBase.replace(/\/+$/, '')}/${adapter.id}/list.html`;
  }
  return adapter.listUrl;
}

/**
 * 条目主键：原文 URL 的 SHA-256 前缀。确定性强 —— 重复抓取、跨库重建都命中
 * 同一 id，/go/<id> 的点击计数因此能稳定累计。
 */
function noticeIdFor(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

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
  };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
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
  try {
    const detailHtml = await fetchText(notice.url);
    const detail = await adapter.parseDetail(detailHtml, notice.url);
    return detail ? mergeDetail(notice, detail) : notice;
  } catch (error) {
    ctx.logger(
      `详情页抓取失败（保留列表层数据）url=${notice.url}：${errorMessage(error)}`,
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
        for (const notice of listItems) {
          const normalized = await enrichWithDetail(adapter, notice, ctx);
          const result = await upsertNotice({
            id: noticeIdFor(normalized.url),
            sourceId: adapter.id,
            title: normalized.title,
            agency: normalized.agency,
            url: normalized.url,
            publishedAt: normalized.publishedAt,
            deadlineAt: normalized.deadlineAt,
            status: deriveStatus(normalized.deadlineAt, now),
            categoryTags: [],
            bodyText: normalized.bodyText,
            attachments: normalized.attachments,
            fetchedAt: now.toISOString(),
          });
          if (result === 'inserted') {
            inserted += 1;
          } else {
            updated += 1;
          }
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
      } catch (error) {
        await upsertSource({
          id: adapter.id,
          name: adapter.name,
          adapterType: adapter.id,
          healthy: false,
        }).catch(() => {
          // 健康状态登记失败不掩盖原始抓取错误
        });
        ctx.logger(`源 ${adapter.id} 抓取失败（listUrl=${listUrl}）：${errorMessage(error)}`);
      }
    }
  },
};
