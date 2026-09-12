import {
  getNoticesByIds,
  listAllNoticesForReindex,
} from '../../db/repo/notices.ts';
import { createSearchPort, type SearchPort } from '../ports.ts';
import { buildSearchDocument } from './search-text.ts';

/**
 * 检索索引同步（issue #8）：把库内条目同步到 SearchPort（ADR-0001 第 2 条）。
 *
 * 同步策略（双层）：
 * 1. 事件钩子 —— 抓取入库 / 更新后、摘要落库后立即同步受影响条目
 *    （入库与更新时自动同步索引，issue #8 AC 第 1 条）；
 * 2. 周期全量重建 —— worker 注册表末位的 reindex-notices 任务每轮把库内
 *    全量条目重刷索引，兜住钩子降级失败与人工补录等旁路写入；
 *    `node scripts/reindex-search.mjs` 提供一次性全量重建入口。
 *
 * 失败策略：钩子内同步失败只记日志降级（搜索结果暂缺可由重建兜底），
 * 不打断抓取 / 摘要主管线；重建任务的失败由 worker 主循环统一记日志。
 */

/** 同步指定条目到检索索引（取库内最新内容构建文档）。返回实际同步条数。 */
export async function syncNoticesToSearchIndex(
  ids: string[],
  log?: (message: string) => void,
): Promise<number> {
  if (ids.length === 0) return 0;
  const records = await getNoticesByIds(ids);
  if (records.length === 0) return 0;
  const port = createSearchPort();
  await port.index(records.map(buildSearchDocument));
  log?.(`检索索引已同步 ${records.length} 条（provider=${port.provider}）`);
  return records.length;
}

/** 全量重建：库内全部条目重刷索引（幂等 upsert）。返回重建条数。 */
export async function reindexAllNotices(log?: (message: string) => void): Promise<number> {
  const records = await listAllNoticesForReindex();
  const port: SearchPort = createSearchPort();
  await port.index(records.map(buildSearchDocument));
  log?.(
    `检索索引重建完成：${records.length} 条（provider=${port.provider}）`,
  );
  return records.length;
}
