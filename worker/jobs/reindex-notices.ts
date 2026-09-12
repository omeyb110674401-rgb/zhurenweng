import { reindexAllNotices } from '../../src/lib/search/sync.ts';
import type { Job, JobContext } from '../registry.ts';

/**
 * 检索索引全量重建任务（issue #8）：把库内全部条目重刷进 SearchPort
 * （provider 由 SEARCH_PROVIDER 决定：local / meilisearch）。
 *
 * 定位：
 * 1. 兜底 —— 抓取 / 摘要任务内的索引同步钩子失败时（只记日志降级），
 *    本任务在下一轮把索引补齐；
 * 2. 一次性重建入口 —— 需要立即重建时可执行
 *    `node scripts/reindex-search.mjs`（不跑抓取等其他任务）。
 *
 * 注册在 jobs 数组末位（追加约定）：每轮先抓取、摘要，最后重建索引。
 */
export const reindexNoticesJob: Job = {
  name: 'reindex-notices',
  description: '全量重建检索索引：库内全部条目重刷 SearchPort（钩子同步的兜底与一次性重建入口）',
  async run(ctx: JobContext): Promise<void> {
    await reindexAllNotices(ctx.logger);
  },
};
