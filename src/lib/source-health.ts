/**
 * 源数据质量判据（issue #51）。
 *
 * 为什么需要它：抓取任务对**逐条失败**是宽容的 —— 详情抓不到就沿用已入库的详情层字段
 * （issue #30）、单条入库失败只跳过那一条（issue #51）。这是对的，一条坏数据不该拖垮
 * 整个源。但宽容的另一面是**没人知道**：源站改版让详情解析全落空时，旧代码照样打印
 * 「抓取完成」并把源标成健康，正文 / 截止日期 / 附件就这么静默烂下去 —— 健康看板全绿、
 * 告警不响，等到有人发现时数据已经旧了很久。宽容必须配一个「过半失败就说话」的判据。
 *
 * 阈值取「过半」而不是「有失败」：偶发一两条失败是常态（政府站点偶发 5xx / 超时），
 * 报了就是狼来了；过半失败才是源站改版或库异常的信号。
 * 列表太短（1-2 条）不足以判断，一律不报。
 */
export const DEGRADED_MIN_LIST = 3;

/** 本轮是否应判为「源数据质量降级」：列表不少于 3 条且过半条目逐条失败。 */
export function isSourceDegraded(listCount: number, failedCount: number): boolean {
  if (!Number.isInteger(listCount) || !Number.isInteger(failedCount)) return false;
  if (listCount < DEGRADED_MIN_LIST || failedCount <= 0) return false;
  return failedCount * 2 >= listCount;
}
