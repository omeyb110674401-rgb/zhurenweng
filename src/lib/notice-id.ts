import { createHash } from 'node:crypto';

/**
 * 条目主键推导（issue #3 起约定）：原文 URL 的 SHA-256 前缀。
 * 确定性强 —— 重复抓取、跨库重建、人工补录同一条目都命中同一 id，
 * /go/<id> 的点击计数因此能稳定累计。
 * 抓取任务与手动补录（issue #12）共用本函数，保证同一原文 URL 走两条
 * 入口时幂等命中同一行（以 URL 为唯一键去重）。
 */
export function noticeIdForUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}
