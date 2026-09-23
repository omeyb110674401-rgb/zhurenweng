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

/**
 * 下面两条判据管的是**另一根轴**：`isSourceDegraded` 看「一轮之内坏得多不多」，
 * 这两个看「跨轮连着坏了多久」（issue #58）。
 *
 * 为什么需要第二根轴：抓取失败一次就把源翻红，而告警按日历日去重 —— 一个偶发超时的
 * 源（人大网实测如此）于是每天红一次、每天一封邮件，且成功后错误列还留着，看板上
 * 永远像正在出事。噪声的日常化比漏报更糟：它会训练人跳过那封邮件。
 * 门槛取 2 而不是 3：每日一轮的前提下，3 轮意味着真断流要三天没人管。
 */
export const SOURCE_UNHEALTHY_AFTER_CONSECUTIVE_FAILURES = 2;

/** 持续故障时的重发间隔（轮数）。 */
export const ALERT_REPEAT_EVERY_ROUNDS = 7;

/** 连续失败 n 轮是否判为不健康。 */
export function isSourceUnhealthy(consecutiveFailures: number): boolean {
  return consecutiveFailures >= SOURCE_UNHEALTHY_AFTER_CONSECUTIVE_FAILURES;
}

/**
 * 连续失败 n 轮时是否发告警邮件。
 *
 * 第 1 轮不发（抖动，看板上有计数，不打扰人）；第 2 轮必发（真出事最坏晚一天）；
 * 此后每 7 轮重发一次封顶 —— 一直坏着的源不能被「当日只发一封」的去重变成哑火，
 * 也不该每天一封变成背景噪声。
 */
export function shouldAlertForSourceFailure(consecutiveFailures: number): boolean {
  if (consecutiveFailures < SOURCE_UNHEALTHY_AFTER_CONSECUTIVE_FAILURES) return false;
  const since = consecutiveFailures - SOURCE_UNHEALTHY_AFTER_CONSECUTIVE_FAILURES;
  return since % ALERT_REPEAT_EVERY_ROUNDS === 0;
}
