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

/**
 * RSS 是本站三条"读者直接用得着"的入口之一（首页关键词框、/search、RSS），而它和检索
 * 一样属于"典型坏法不是报错、是静默少结果"的那类：端点 200、XML 打得开、里面少了最新
 * 那批条目，读者什么都看不见，只以为自己订阅的那些事最近没发生（issue #72 量过另外两条，
 * #74 把它们收进同一张清单，这一条补上第三条入口）。
 *
 * 因此这里的判据不是"feed 有没有响应"，而是**读者从 feed 里拿到的那批条目，等于库里今天
 * 该出现的那批吗**：条目集合、绝对链接的宿主、XML 的良构性分开判，三者处置不同。
 *
 * 良构性检查是**启发式**（正则数开合标签、找裸 `&` 与控制字符），不是 XML 解析器 ——
 * 本仓库生成 feed 时也是零依赖自拼 XML（见 `src/lib/feed.ts`）。它能抓住真实出现过的那类
 * 坏法（正文/标题里混进控制字符或没转义的 `&` ⇒ 阅读器整份拒收），但不保证证明良构；
 * detail 里写着"启发式"，别把它当成"XML 校验通过"。
 */

export interface FeedSample {
  channelTitle: string | null;
  items: { guid: string; pubDate: string | null; link: string | null }[];
  /** 结构上看着不对的一句话说明；null = 启发式没抓到问题 */
  malformed: string | null;
}

const FEED_ITEM_RE = /<item>([\s\S]*?)<\/item>/g;

/** 库里条目多于 feed 上限时，只比对"最新的那些"条目有没有出现在 feed 里。 */
export const FEED_NEWHOOD_SAMPLE = 30;

/**
 * feed 里"今天该出现"的那批 id。
 * 库里条目没超过 feed 上限 ⇒ 全量都该在里面（超上限后第 200 名附近受排序并列影响，
 * 逐条比对会误报，所以那时只比对最新的一小截 —— 它足以抓住"feed 停止更新"这一类坏法）。
 */
export function feedExpectedIds(
  records: { id: string; publishedAt: string | null }[],
  maxItems: number,
): string[] {
  if (records.length <= maxItems) return records.map((record) => record.id);
  return [...records]
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
    .slice(0, FEED_NEWHOOD_SAMPLE)
    .map((record) => record.id);
}

function feedField(block: string, name: string): string | null {
  // guid 带属性（isPermaLink），所以开标签允许属性段
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(block);
  return match ? match[1].trim() : null;
}

/** 控制字符会让阅读器把整份 feed 判定非法；不用正则字符类（被 lint 的 no-control-regex 挡下，逐码点也更直白）。 */
function hasControlChar(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
  }
  return false;
}

/** 从 feed XML 里取出比对要用的最小字段（guid / pubDate / link）并做结构体检。 */
export function parseFeedSample(xml: string): FeedSample {
  const opens = (xml.match(/<item>/g) ?? []).length;
  const closes = (xml.match(/<\/item>/g) ?? []).length;
  const malformed =
    xml.trim().length === 0
      ? '响应体是空的'
      : !xml.includes('<rss') || !xml.includes('<channel')
        ? '缺少 <rss> 或 <channel>'
        : opens !== closes
          ? `<item> 开合不配对（${opens} / ${closes}）`
          : /&(?!(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/.test(xml)
            ? '有没转义的 &（阅读器会判为非法 XML）'
            : hasControlChar(xml)
              ? '含 XML 控制字符'
              : null;
  const items: FeedSample['items'] = [];  for (const match of xml.matchAll(FEED_ITEM_RE)) {
    const guid = feedField(match[1], 'guid') ?? '';
    items.push({ guid, pubDate: feedField(match[1], 'pubDate'), link: feedField(match[1], 'link') });
  }
  return { channelTitle: feedField(xml, 'title'), items, malformed };
}

export function rssFeedHealth(input: {
  /** 探针那一侧只有一个入口：要么取到了内容，要么带着取不到的原因 —— 两条独立判空会留一支永远走不到的死枝 */
  feed: { ok: true; sample: FeedSample } | { ok: false; error: string };
  /** 库里"今天该出现在 feed 里"的那批 id（比对口径由调用方定，见 audit-rss-feed 脚本） */
  missingIds: string[];
  ghostIds: string[];
  badLinks: string[];
  dbCount: number;
}): HealthCheck {
  const name = 'RSS feed 产物';
  if (input.feed.ok === false) {
    return { name, verdict: 'unknown', detail: `探针没取到 feed：${input.feed.error} ⇒ 不判健康` };
  }
  const sample = input.feed.sample;
  if (sample.malformed !== null) {
    return { name, verdict: 'fail', detail: `结构不对（启发式）：${sample.malformed}` };
  }
  if (sample.items.length === 0) {
    return { name, verdict: 'fail', detail: `feed 里 0 条 item，而库里有 ${input.dbCount} 条 ⇒ 订了也拿不到东西` };
  }
  if (input.missingIds.length > 0) {
    return {
      name,
      verdict: 'fail',
      detail: `库里有、feed 里没有 ${input.missingIds.length} 条（前几条 ${input.missingIds.slice(0, 3).join(', ')}）`,
    };
  }
  if (input.ghostIds.length > 0) {
    return {
      name,
      verdict: 'fail',
      detail: `feed 里有 ${input.ghostIds.length} 条库里没有的 guid（前几条 ${input.ghostIds.slice(0, 3).join(', ')}）`,
    };
  }
  if (input.badLinks.length > 0) {
    return {
      name,
      verdict: 'fail',
      detail: `${input.badLinks.length} 条 link 不指向本站，例如 ${input.badLinks.slice(0, 2).join(' 、 ')}`,
    };
  }
  return {
    name,
    verdict: 'ok',
    detail: `${sample.items.length} 条 item，guid 与库里对得上、链接指向本站（结构只做启发式检查）`,
  };
}

/**
 * 取一次线上 feed 并与库里比对，产成 `rssFeedHealth` 的结论。
 * 与 `auditIndexSampling` 同样放在判据模块里：#75 的专用审计与 #74 的健康清单必须给同一个答案，
 * 两处各写一遍"什么叫 feed 落后了"迟早会一个严一个松。
 * 唯一的不对称：`siteBase` 为空时链接宿主这项**不判**（没有可信的"本站"定义），
 * 其余三条照判 —— 拿内部地址去判"链接不指向本站"会造出假红灯。
 */
export async function auditRssFeed(input: {
  url: string;
  siteBase: string;
  records: { id: string; publishedAt: string | null }[];
  maxItems: number;
  timeoutMs?: number;
}): Promise<{
  check: HealthCheck;
  missingIds: string[];
  ghostIds: string[];
  badLinks: string[];
  feedCount: number;
}> {
  let fetchError: string | null = null;
  let xml = '';
  if (input.url === '') {
    fetchError = '没有可取的地址（SITE_URL 未配且没给 --url）';
  } else {
    try {
      const response = await fetch(input.url, {
        signal: AbortSignal.timeout(input.timeoutMs ?? 8_000),
      });
      if (!response.ok) fetchError = `${input.url} 返回 ${response.status}`;
      else xml = await response.text();
    } catch (error) {
      fetchError = `${input.url} 取不到：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  // 取不到就没有"比对"这回事：三份清单都留空，否则调用方会把"探针没跑成"打印成"全都缺"
  if (fetchError !== null) {
    return {
      check: rssFeedHealth({ feed: { ok: false, error: fetchError }, missingIds: [], ghostIds: [], badLinks: [], dbCount: input.records.length }),
      missingIds: [],
      ghostIds: [],
      badLinks: [],
      feedCount: 0,
    };
  }
  const sample = parseFeedSample(xml);
  const feedIds = sample.items.map((item) => item.guid);
  const dbIds = new Set(input.records.map((record) => record.id));
  const inFeed = new Set(feedIds);
  const missingIds = feedExpectedIds(input.records, input.maxItems).filter((id) => !inFeed.has(id));
  const ghostIds = feedIds.filter((id) => !dbIds.has(id));
  const badLinks =
    input.siteBase === ''
      ? []
      : sample.items
          .filter((item) => item.link === null || !item.link.startsWith(`${input.siteBase}/`))
          .map((item) => item.link ?? '(缺 link)');
  return {
    check: rssFeedHealth({
      feed: { ok: true, sample },
      missingIds,
      ghostIds,
      badLinks,
      dbCount: input.records.length,
    }),
    missingIds,
    ghostIds,
    badLinks,
    feedCount: feedIds.length,
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
