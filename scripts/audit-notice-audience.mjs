#!/usr/bin/env node
/**
 * 受众面审计（issue #83）：把**全库**的判定与依据逐条打出来，供人工核对。
 *
 * 与 `tag-notice-audience.mjs` 的分工：那个是**写库**入口（回填），这个是**读**入口
 * （核对）。分类法的价值全压在"判得对不对"上，而判得对不对只能一条条看 ——
 * 所以这里不打分桶，打全量：每条一行，带 id 前缀（登记人工覆盖表时要用）、
 * 标题与那句人话依据。
 *
 * 常用姿势：
 *   node scripts/audit-notice-audience.mjs                    # 全库：分桶 + 依据分布 + 逐条
 *   node scripts/audit-notice-audience.mjs --audience public  # 只看某一类
 *   node scripts/audit-notice-audience.mjs --open             # 只看还在征求意见的
 * 判错的处理方式（**不要改关键词了事**）：把条目 id 前缀与理由登记进
 * `src/lib/audience.ts` 的 `AUDIENCE_OVERRIDES`，再跑回填脚本 —— 覆盖表管"我核过的
 * 这一条"，规则表管"大多数"，两者分开回归测试才钉得住。
 */
import { getDb } from '../src/db/client.ts';
import { listAllNoticesForReindex } from '../src/db/repo/notices.ts';
import { AUDIENCE_LABELS } from '../src/lib/audience.ts';
import { effectiveStatus } from '../src/lib/notice-status.ts';

const argv = process.argv.slice(2);
const only = argv.includes('--audience') ? argv[argv.indexOf('--audience') + 1] : undefined;
const openOnly = argv.includes('--open');

await getDb();
const notices = await listAllNoticesForReindex();
const now = new Date();
const rows = notices
  .map((notice) => ({
    id: notice.id,
    title: notice.title,
    sourceId: notice.sourceId,
    audience: notice.audience ?? 'unknown',
    basis: notice.audienceBasis ?? '（本列上线前的存量，没判定过）',
    status: effectiveStatus(notice, now),
  }))
  .filter((row) => (only === undefined ? true : row.audience === only))
  .filter((row) => (openOnly ? row.status === 'open' : true));

const counts = new Map();
for (const row of rows) counts.set(row.audience, (counts.get(row.audience) ?? 0) + 1);
console.log(
  `[audit-audience] ${rows.length} 条${only ? `（只列 ${only}）` : ''}${openOnly ? '（只在征集中的）' : ''}：` +
    [...counts].map(([audience, n]) => `${AUDIENCE_LABELS[audience] ?? audience}=${n}`).join('  '),
);

// 依据的分布比条数更有用：某条规则吃掉一大片，往往就是它判粗了
const byBasis = new Map();
for (const row of rows) {
  const key = row.basis.replace(/「[^」]*」/g, '「…」');
  byBasis.set(key, (byBasis.get(key) ?? 0) + 1);
}
console.log('  依据分布：');
for (const [basis, n] of [...byBasis].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(3)}  ${basis}`);
}

console.log('  逐条：');
for (const row of rows) {
  console.log(
    `    ${row.id.slice(0, 8)}  ${(AUDIENCE_LABELS[row.audience] ?? row.audience).padEnd(5)}  ` +
      `${row.status.padEnd(7)}  ${row.title.slice(0, 40)}  ← ${row.basis.slice(0, 40)}`,
  );
}
