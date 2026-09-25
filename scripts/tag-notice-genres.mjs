#!/usr/bin/env node
/**
 * 体裁回填（issue #76）：给存量条目补上 `genre`。
 *
 * 为什么要有这一条：新判定只在**入库时**算，而库里已有 192 条存量 —— 不回填的话
 * 摘要管线看到的还是"没有体裁"，分情况讨论就落不了地。
 *
 * 判据不在这儿重写一遍：用的是生产路径同一份 `deriveNoticeGenre` + 同一条覆盖规矩
 * （`genreDecisionWins`，弱证据不许盖强证据）。两处各写一份迟早一个严一个松，
 * 那正是 issue #50 修过的老坑。
 *
 * 用法：
 *   docker compose run --rm worker node scripts/tag-notice-genres.mjs            # 只报告，不写
 *   docker compose run --rm worker node scripts/tag-notice-genres.mjs --apply    # 写库
 * 只跑 --apply 时才需要镜像里有本文件；dry-run 可以按 deploy/README.md 的办法单文件挂载。
 */
import { getDb } from '../src/db/client.ts';
import { backfillNoticeGenres } from '../src/db/repo/notices.ts';

const apply = process.argv.slice(2).includes('--apply');

await getDb();
const report = await backfillNoticeGenres({ apply });

console.log(
  `[tag-genres] 条目 ${report.total} 条 ｜ 已有判定且不被覆盖 ${report.skipped} ｜ ` +
    `本次${apply ? '写入' : '拟写入'} ${report.changed} ｜ 未判定 ${report.unknown}`,
);
const counts = Object.entries(report.byGenre).sort((a, b) => b[1] - a[1]);
console.log(`  分桶：${counts.map(([genre, n]) => `${genre}=${n}`).join('  ')}`);
for (const row of report.samples.slice(0, 12)) {
  console.log(`  ${row.from ?? '∅'} → ${row.to}  ${row.title.slice(0, 34)}  ← ${row.basis.slice(0, 42)}`);
}
if (report.samples.length > 12) console.log(`  …另 ${report.samples.length - 12} 条（--apply 前可加 --all 打印全部）`);
if (!apply) console.log('[tag-genres] 这是 dry-run，没有写库。确认分桶后用 --apply。');
