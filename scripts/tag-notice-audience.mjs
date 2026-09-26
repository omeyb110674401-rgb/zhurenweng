#!/usr/bin/env node
/**
 * 受众面回填（issue #83）：给存量条目补上 `audience` / `audience_basis`。
 *
 * 为什么要有这一条：判定只在**入库时**算，而库里已有 190+ 条存量 —— 不回填的话
 * 列表页的受众面筛选会把全库都算进「未判定」，那个筛选器等于对着一个空分类说话。
 *
 * 判据不在这儿重写一遍：用的是生产路径同一份 `deriveNoticeAudience`（含人工覆盖表）。
 * 两处各写一份迟早一个严一个松 —— 那是 issue #50 修过的老坑。
 *
 * **没有 `--force`**，而且这是有意的：受众面的判据只有标题与来源两样、入库时就齐了，
 * 每次算出来都是同一个答案；体裁那边的 `--force` 是因为它的证据分强弱（正文 > 附件名 >
 * 标题），词表一换旧结论就过期。加一条不该加的逃生门，只会让下一个人以为自己也改不动。
 * 改了 `lib/audience.ts` 的词表或覆盖表之后，直接跑 `--apply` 就生效。
 *
 * 用法：
 *   docker compose run --rm worker node scripts/tag-notice-audience.mjs          # 只报告，不写
 *   docker compose run --rm worker node scripts/tag-notice-audience.mjs --apply  # 写库
 * 注意 `compose run` 用的是**镜像里**的代码：改了 repo 里的判据要先 build worker 才生效
 * （#67 那次"同步 ≠ 部署"的教训）。逐条核对判定用 scripts/audit-notice-audience.mjs。
 */
import { getDb } from '../src/db/client.ts';
import { backfillNoticeAudiences } from '../src/db/repo/notices.ts';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const showAll = argv.includes('--all');

await getDb();
const report = await backfillNoticeAudiences({ apply });

console.log(
  `[tag-audience] 条目 ${report.total} 条 ｜ 本次${apply ? '写入' : '拟写入'} ${report.changed}`,
);
const counts = Object.entries(report.byAudience).sort((a, b) => b[1] - a[1]);
console.log(`  分桶：${counts.map(([audience, n]) => `${audience}=${n}`).join('  ')}`);
const listed = showAll ? report.samples : report.samples.slice(0, 12);
for (const row of listed) {
  console.log(`  ${row.from ?? '∅'} → ${row.to}  ${row.title.slice(0, 34)}  ← ${row.basis.slice(0, 46)}`);
}
if (!showAll && report.samples.length > listed.length) {
  console.log(`  …另 ${report.samples.length - listed.length} 条（加 --all 打印全部）`);
}
if (!apply) console.log('[tag-audience] 这是 dry-run，没有写库。确认分桶后用 --apply。');
