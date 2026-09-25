import type { SearchPort } from './ports.ts';

/**
 * 管线健康的判据（issue #74）—— 纯函数，脚本与测试共用同一套阈值。
 *
 * 为什么把这堆判断单独立成一个模块：#68 抓到"每日备份 cron 从未触发"之后，我连着用
 * 同一把尺子量了四五个面上（#70 发信路径、#71 失败告警、#72 检索索引与点击口径、
 * #73 订阅产出）。每一次都是现写一次查询 —— 那说明缺的不是 SQL，是**一个会周期性逼问
 * "今天有没有产物"的清单**。判据散在对话里就会腐烂：阈值没人复查、结论没人重算。
 *
 * 四态而不是两态，刻意保留 `unknown`：探针没挂载、数据不存在时**不能报成健康**。
 * #68 的根因就是"没有反证也算通过"（unit active 就算装好了）。把"我不知道"折叠成
 * "没问题"，是这类检查最危险的失败方式。
 */

export type HealthVerdict = 'ok' | 'warn' | 'fail' | 'unknown';

export interface HealthCheck {
  name: string;
  verdict: HealthVerdict;
  detail: string;
}

/** 备份归档超过这么久没更新就是异常（cron 每天一次，留 2 小时余量给运行时长与漂移）。 */
export const BACKUP_MAX_AGE_HOURS = 26;
/** 抓取每天一轮；超过两轮没新收录就该问为什么。 */
export const CRAWL_MAX_SILENCE_HOURS = 48;
/** 摘要队列积压超过它 ⇒ warn（每轮上限 50，长期积压说明有条目反复失败）。 */
export const SUMMARY_BACKLOG_WARN = 50;

/** 备份产物新鲜度。`seenDir=false` 是探针没看到目录（容器里没挂载），不是"没有备份"。 */
export function backupFreshness(input: {
  seenDir: boolean;
  newestAgeHours: number | null;
}): HealthCheck {
  if (!input.seenDir) {
    return {
      name: '每日备份产物',
      verdict: 'unknown',
      detail: '没看到 /var/backups/zhurenweng（容器里要用 -v 挂进来才知道），不判健康',
    };
  }
  if (input.newestAgeHours === null) {
    return { name: '每日备份产物', verdict: 'fail', detail: '目录里没有 zhurenweng-*.dump ⇒ 从没成功备份过' };
  }
  const age = input.newestAgeHours.toFixed(1);
  return {
    name: '每日备份产物',
    verdict: input.newestAgeHours <= BACKUP_MAX_AGE_HOURS ? 'ok' : 'fail',
    detail: `最新 dump ${age} 小时前（阈值 ${BACKUP_MAX_AGE_HOURS} 小时）`,
  };
}

/** 抓取是否还在送新东西（`max(first_seen_at)`）。注意：存量该列为 NULL，是刻意不回填的。 */
export function crawlFreshness(hoursSinceNewNotice: number | null): HealthCheck {
  if (hoursSinceNewNotice === null) {
    return {
      name: '抓取新鲜度',
      verdict: 'unknown',
      detail: '没有任何一条有 first_seen_at（存量不回填是有意为之），无法判断',
    };
  }
  const age = hoursSinceNewNotice.toFixed(1);
  return {
    name: '抓取新鲜度',
    verdict: hoursSinceNewNotice <= CRAWL_MAX_SILENCE_HOURS ? 'ok' : 'warn',
    detail: `最近一条新收录 ${age} 小时前（阈值 ${CRAWL_MAX_SILENCE_HOURS} 小时）`,
  };
}

/** 检索索引自证抽样的结论（判据在 `scripts/audit-search-index.mjs` 里，同一份规则）。 */
export function indexHealth(checked: number, missed: number): HealthCheck {
  if (checked === 0) {
    return { name: '检索索引可搜性', verdict: 'unknown', detail: '没有可抽样的条目' };
  }
  return {
    name: '检索索引可搜性',
    verdict: missed === 0 ? 'ok' : 'fail',
    detail: `抽样 ${checked} 条，搜不到自己的 ${missed} 条`,
  };
}

/** 摘要队列积压。 */
export function summaryBacklog(pendingOpen: number): HealthCheck {
  return {
    name: '摘要队列',
    verdict: pendingOpen === 0 ? 'ok' : pendingOpen <= SUMMARY_BACKLOG_WARN ? 'ok' : 'warn',
    detail: `待生成 ${pendingOpen} 条（每轮上限 50）`,
  };
}

/**
 * 发信闭环有没有"可发的收件人"。
 * 0 个是**需求侧事实**不是故障，所以只给 warn —— 但必须出现在清单里：#70 时那两个 0 行
 * 之所以要看两轮才知道是"没收件人"而不是"路径坏了"，就是因为这个数没被单独摆出来。
 */
export function mailLoop(mailableSubscribers: number, emailsSentEver: number): HealthCheck {
  if (mailableSubscribers === 0) {
    return {
      name: '发信闭环',
      verdict: 'warn',
      detail: `可发订阅者 0 人（历史发出 ${emailsSentEver} 封）⇒ 提醒/通知不会有产出，这是需求侧事实不是故障`,
    };
  }
  return {
    name: '发信闭环',
    verdict: emailsSentEver > 0 ? 'ok' : 'warn',
    detail: `可发订阅者 ${mailableSubscribers} 人（历史发出 ${emailsSentEver} 封）`,
  };
}

/** 读者有没有在用它（近 7 天出站点击）。同样是需求侧事实，不是故障。 */
export function readerActivity(clicksLast7Days: number): HealthCheck {
  return {
    name: '近 7 天出站点击',
    verdict: clicksLast7Days > 0 ? 'ok' : 'warn',
    detail: `${clicksLast7Days} 次（0 次是需求侧事实，不判故障）`,
  };
}

export const VERDICT_ORDER: Record<HealthVerdict, number> = { fail: 0, warn: 1, unknown: 2, ok: 3 };

/** 总体结论：有 fail 就是 fail；没 fail 有 warn/unknown 就 warn；全 ok 才 ok。 */
export function overallVerdict(checks: HealthCheck[]): HealthVerdict {
  if (checks.some((check) => check.verdict === 'fail')) return 'fail';
  if (checks.some((check) => check.verdict !== 'ok')) return 'warn';
  return 'ok';
}

/** 索引抽样用的"自证式查询词"：优先书名号里的法规/标准名，否则标题前 10 字。 */
export function probeOf(title: string): string {
  const quoted = /《([^》]{4,40})》/.exec(title);
  if (quoted) return quoted[1];
  return title.slice(0, 10);
}

/**
 * 抽样问检索后端："这条公示还找得到自己吗"。
 * 放在判据模块里而不是各脚本各写一份：#72 的专用审计与 #74 的健康清单必须给同一个答案，
 * 两处各写一遍迟早会一个严一个松（那正是 issue #50 修的"同一个查询三条路径三种结果"的老坑）。
 */
export async function auditIndexSampling(
  port: SearchPort,
  records: { id: string; title: string }[],
  options: { stride: number; perPage: number; max: number },
): Promise<{
  checked: number;
  missed: { id: string; query: string; total: number; why: string }[];
}> {
  const samples = records
    .filter((unused, index) => index % options.stride === 0)
    .slice(0, options.max);
  const missed: { id: string; query: string; total: number; why: string }[] = [];
  for (const record of samples) {
    const query = probeOf(record.title);
    // 单条查询报错不算"搜不到"，但也不能跳过 —— 报后端故障与报索引缺失的处置完全不同，
    // 所以带着 total:-1 一起进结果，由调用方按类别打印
    let result;
    try {
      result = await port.search(query, { perPage: options.perPage });
    } catch (error) {
      missed.push({
        id: record.id,
        query,
        total: -1,
        why: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!result.hits.some((hit) => hit.id === record.id)) {
      missed.push({ id: record.id, query, total: result.total, why: '' });
    }
  }
  return { checked: samples.length, missed };
}
