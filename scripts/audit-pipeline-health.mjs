#!/usr/bin/env node
/**
 * 只读：一次问完"这套系统今天还在工作吗"（issue #74）。
 *
 * 来历：#68 抓到每日备份 cron 从未触发之后，我用同一把尺子连着量了四个面（#70 发信路径、
 * #71 失败告警、#72 检索索引与点击口径、#73 订阅产出）。每次都是现写查询 —— 那说明缺的不是
 * SQL，是**一个会周期性逼问"有没有产物"的清单**。判据散在对话里就会腐烂。
 *
 * 三条硬规矩（都来自这几天踩过的坑）：
 * 1. 探针看不到就说看不到。`unknown` 不算健康 —— #68 的根因正是"unit active 就算装好了"，
 *    把"我不知道"折叠成"没问题"是这类检查最危险的失败方式；
 * 2. 需求侧事实（0 个订阅者、0 次点击）判 `warn` 不判 `fail` —— 它不是故障，但必须出现在
 *    同一张表里，否则下次又要靠人分辨"路径坏了"和"没人可发"（#70 就是这么来回看了两轮）；
 * 3. 判定全在 `src/lib/pipeline-health.ts` 里，脚本只负责取数 —— 阈值要能被单测钉住。
 *
 * 只跑生产 PG（查询用了 `::int` / `to_char` 等方言形状）：这是运维只读工具，不是被测路径，
 * 为它做双方言只会多一片没人走的代码 —— 与 ADR-0001「只有被测到的地方才付双方言成本」一致。
 *
 * 用法（容器里，需要 DATABASE_URL；要看备份产物就把备份目录挂进来）：
 *   docker compose run --rm -v /var/backups/zhurenweng:/var/backups/zhurenweng:ro \\
 *     worker node scripts/audit-pipeline-health.mjs
 * 退出码：有 `fail` ⇒ 1；只有 `warn`/`unknown` ⇒ 0（清单会把它们打在行首）。
 */
// 这个文件是 .mjs ⇒ 里面**不能有任何 TS 语法**（Node 只对 .ts 做类型剥离，内联的
// `import { type X }` 会直接 SyntaxError），判据模块 pipeline-health.ts 才是带类型的地方。
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { getDb } from '../src/db/client.ts';
import { listAllNoticesForReindex } from '../src/db/repo/notices.ts';
import { FEED_MAX_ITEMS } from '../src/lib/feed.ts';
import { createSearchPort } from '../src/lib/ports.ts';
import {
  auditIndexSampling,
  auditRssFeed,
  backupFreshness,
  crawlFreshness,
  indexHealth,
  mailLoop,
  overallVerdict,
  readerActivity,
  summaryBacklog,
} from '../src/lib/pipeline-health.ts';

const BACKUP_DIR = process.env.BACKUP_DIR || '/var/backups/zhurenweng';
const HOUR_MS = 3_600_000;

await getDb();   // 与仓库同一套连接与迁移检查；下面取数走只读的原生连接
const now = new Date();
// 取标量用 pg 直连（与 scripts/audit-briefs.mjs 同一做法）：drizzle 的这个实例上没有 db.all
const pg = new Client({ connectionString: process.env.DATABASE_URL });
await pg.connect();
const checks = [];

// ── 备份产物（#68 的直接教训：这个面上"没人看产物"就是没有防线）──────────────
let seenDir = false;
let newestAgeHours = null;
try {
  const dumps = fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => /^zhurenweng-\d{4}-\d{2}-\d{2}-\d{6}\.dump$/.test(name))
    .map((name) => fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs);
  seenDir = true;
  if (dumps.length > 0) newestAgeHours = (now.getTime() - Math.max(...dumps)) / HOUR_MS;
} catch {
  seenDir = false;
}
checks.push(backupFreshness({ seenDir, newestAgeHours }));

// ── 库里那些"活管道"的信号 ────────────────────────────────────────────────
const all = await listAllNoticesForReindex();
const firstSeen = all
  .map((row) => row.firstSeenAt)
  .filter((value) => typeof value === 'string' && value !== '')
  .sort();
checks.push(
  crawlFreshness(
    firstSeen.length === 0
      ? null
      : (now.getTime() - Date.parse(firstSeen[firstSeen.length - 1])) / HOUR_MS,
  ),
);

// 这个探针只跑在生产那台 PG 上（查询里用了 ::int / to_char / now() at time zone），
// 换 SQLite 会直接报错 —— 刻意不兼容：它是运维只读工具，不是被测路径，做双方言只是虚增面积
const one = async (text) => {
  const { rows } = await pg.query(text);
  return Number(rows?.[0]?.value ?? 0);
};
const pendingOpen = await one(
  "select count(*)::int as value from notices where ai_summary_json is null and summary_status = 'pending' and status <> 'closed'",
);
checks.push(summaryBacklog(pendingOpen));

const mailable = await one(
  "select count(*)::int as value from subscriptions where confirmed = 1 and unsubscribed_at is null",
);
const sentEmails =
  (await one('select count(*)::int as value from reminder_sends')) +
  (await one('select count(*)::int as value from notice_notifications'));
checks.push(mailLoop(mailable, sentEmails));

const clicks7d = await one(
  `select coalesce(sum(clicks), 0)::int as value from outbound_click_daily
     where click_date >= to_char((now() at time zone 'Asia/Shanghai') - interval '7 day', 'YYYY-MM-DD')`,
);
checks.push(readerActivity(clicks7d));

// ── 检索索引自证抽样（判据与 #72 那份审计同一份函数）────────────────────────
const port = createSearchPort();
let sampling = { checked: 0, missed: [] };
try {
  sampling = await auditIndexSampling(port, all, { stride: 12, perPage: 20, max: 12 });
} catch (error) {
  checks.push({
    name: '检索索引可搜性',
    verdict: 'unknown',
    detail: `探针没跑成：${String(error instanceof Error ? error.message : error)}`,
  });
}
if (!checks.some((check) => check.name === '检索索引可搜性')) {
  checks.push(indexHealth(sampling.checked, sampling.missed.length));
}
for (const miss of sampling.missed.slice(0, 5)) {
  // total=-1 是"单条查询报错"（后端故障），与"搜不到"处置完全不同，分开打
  const kind = miss.total === -1 ? `查询报错：${miss.why}` : `total=${miss.total}`;
  console.log(`  索引漏网 ${miss.id} 词「${miss.query}」 ${kind}`);
}

// ── RSS feed 产物（第三条读者入口，判据与 #75 的专用审计同一份函数）──────────────
const siteBase = (process.env.SITE_URL || '').replace(/\/+$/, '');
const rss = await auditRssFeed({
  url: siteBase === '' ? '' : `${siteBase}/feed.xml`,
  siteBase,
  records: all,
  maxItems: FEED_MAX_ITEMS,
});
checks.push(rss.check);
for (const id of rss.missingIds.slice(0, 3)) console.log(`  feed 缺条目 ${id}`);
for (const link of rss.badLinks.slice(0, 2)) console.log(`  feed 链接不指向本站 ${link}`);

await pg.end();

// ── 输出 ─────────────────────────────────────────────────────────────────
console.log(
  `[health] provider=${port.provider} 条目 ${all.length} 未截止 ${
    all.filter((row) => row.status === 'open').length
  } 备份目录=${seenDir ? BACKUP_DIR : '（未挂载）'}`,
);
const mark = { ok: '✓', warn: '!', fail: '✗', unknown: '?' };
for (const check of checks) {
  console.log(`  ${mark[check.verdict]} ${check.verdict.padEnd(7)} ${check.name}：${check.detail}`);
}
const overall = overallVerdict(checks);
console.log(`[health] 总结论 ${overall}${overall === 'fail' ? ' —— 有东西坏了，别看别的，先处理它' : ''}`);
process.exit(overall === 'fail' ? 1 : 0);
