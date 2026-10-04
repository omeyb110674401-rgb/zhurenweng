/**
 * 审读回填工具（issue #51）：给**已经有好摘要**的条目补上审读记录 —— **只审读、不重跑**。
 *
 * ## 为什么必须有这条通道
 *
 * 审读那一步目前只长在摘要生成链路里（`summarizeOneNotice`）。而门翻转（#52）之后，
 * **没有有效审读记录的判读一律不渲染** —— 于是两类存量会在开门那一刻集体消失：
 *
 * 1. **公众广域那几条**（今天正在线上渲染的判读）：它们的摘要已经完整，按重跑工具的判据
 *    （`src/lib/redraft-candidates.ts`）**不是候选** ⇒ 永远不会被重跑 ⇒ 永远没有审读记录；
 * 2. 任何"不缺件、不该重跑"的存量。
 *
 * 换句话说：只靠重跑补不出"全库覆盖"，而 #52 的验收红线正是"公众广域那 5 条一条都没消失"。
 * 重跑它们既贵（一次生成调用）又没必要（摘要本来就好），所以另开这条**只写审读列**的通道
 * （`saveImpactReviewJson` 只碰那一列，摘要 JSON / 模型名 / 诊断一个字节都不动）。
 *
 * ## 判据与门共用一份（别在这里另算一遍）
 *
 * "覆盖到了没有"= 渲染门认不认那份记录 = `impactReviewCoverage`（内部走 `findImpactReview`，
 * 两个指纹全等才算数）。量具与页面各写一份的表现是"这里说覆盖了、页面却不渲染"。
 * 调用审读本身也复用 `summarizeOneNotice` 用的**同一个** `reviewImpactsForSummary`
 * （邻域按附件名回查正文、独立性核对、六种失败的诊断，全都在那一份实现里）。
 *
 * 用法（在部署了本仓库的容器里跑，需要 DATABASE_URL）：
 *   docker compose run --rm worker node scripts/review-impacts-now.mjs
 *       # 只读：逐条列出"有判读的条目 × 覆盖到几条 / 缺口是哪几条"，零写入、零调用
 *   docker compose run --rm worker node scripts/review-impacts-now.mjs --apply --limit 3
 *       # 金丝雀：先补 3 条，验完页面与库再放量
 *   docker compose run --rm -v /var/backups/zhurenweng:/var/backups/zhurenweng \
 *     worker node scripts/review-impacts-now.mjs --apply --all 2>&1 | tee /root/review.log
 *       # 全量（带着 -v 或 tee：stdout 那份 #BACKUP 才是不会丢的备份）
 *   docker compose run --rm worker node scripts/review-impacts-now.mjs --apply --ids 34d26301
 *       # 点名（8 位前缀，可给多个）
 *
 * 退出码：`--apply` 时只要有一条没跑到 `ok`（超时 / 形状非法 / 没配端口…）就非 0 ——
 * 回填的验收是"缺口为 0"，静默地少补几条正是这条通道要避免的事。
 *
 * 恢复：`#BACKUP {"id":…,"previousImpactReviewJson":…}` 每行一条，按 id 写回
 * `notices.impact_review_json` 即可（那之前的值通常是 NULL = 没有审读记录）。
 */
import { inArray, isNotNull } from 'drizzle-orm';
import { getDb } from '../src/db/client.ts';
import { notices } from '../src/db/schema/sqlite.ts';
import { safeParseJson } from '../src/db/types.ts';
import { saveImpactReviewJson } from '../src/db/repo/summaries.ts';
import { parseQuotedSummary } from '../src/lib/summary-content.ts';
import {
  impactReviewCoverage,
  parseImpactReviews,
  serializeImpactReviews,
} from '../src/lib/impact-review.ts';
import {
  draftSourcesForSummary,
  reviewImpactsForSummary,
} from '../worker/jobs/summarize-notices.ts';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const all = args.has('--all');
const limitIndex = process.argv.indexOf('--limit');
const limit = limitIndex >= 0 ? Number(process.argv[limitIndex + 1]) : all ? Number.POSITIVE_INFINITY : 3;
if (!Number.isFinite(limit) && !all) {
  console.error('--limit 要是正整数（不给就是金丝雀 3 条；要全量请显式写 --all）');
  process.exit(1);
}
if (limit < 1) {
  console.error('--limit 必须 >= 1');
  process.exit(1);
}

const idsIndex = process.argv.indexOf('--ids');
const idArgs =
  idsIndex >= 0
    ? (process.argv[idsIndex + 1] ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '')
    : [];
if (idsIndex >= 0 && idArgs.length === 0) {
  console.error('--ids 后面要跟逗号分隔的 id（可写前 8 位），例如 --ids 34d26301,0b00deff');
  process.exit(1);
}

const db = await getDb();

/**
 * 候选：有摘要的条目。判读与审读记录都从列里读，**覆盖判据不在这里算** ——
 * 它走 `impactReviewCoverage`（与渲染门同一份 `findImpactReview`）。
 */
const rows = await db
  .select({
    id: notices.id,
    title: notices.title,
    url: notices.url,
    bodyText: notices.bodyText,
    sourceId: notices.sourceId,
    genre: notices.genre,
    audience: notices.audience,
    summaryJson: notices.aiSummaryJson,
    reviewJson: notices.impactReviewJson,
  })
  .from(notices)
  .where(isNotNull(notices.aiSummaryJson));

/** 这一条目前覆盖到几分（判读 0 条 ⇒ 不在本工具的范围内）。 */
const inspected = [];
for (const row of rows) {
  const parsed = parseQuotedSummary(safeParseJson(row.summaryJson));
  if (parsed === null || parsed.impacts.length === 0) continue;
  inspected.push({
    row,
    impacts: parsed.impacts,
    coverage: impactReviewCoverage(parsed.impacts, parseImpactReviews(row.reviewJson)),
  });
}

const gapRows = inspected.filter((item) => item.coverage.missing.length > 0);
const impactTotal = inspected.reduce((sum, item) => sum + item.coverage.total, 0);
const coveredTotal = inspected.reduce((sum, item) => sum + item.coverage.covered, 0);

console.log(
  `有判读的条目 ${inspected.length} 条 / 判读 ${impactTotal} 条：` +
    `覆盖 ${coveredTotal} 条，**缺口 ${impactTotal - coveredTotal} 条**（分布在 ${gapRows.length} 条条目上）`,
);
for (const item of inspected) {
  const { coverage } = item;
  const mark = coverage.missing.length === 0 ? '✔' : '缺口';
  console.log(
    `  ${mark} ${item.row.id.slice(0, 8)}  覆盖 ${coverage.covered}/${coverage.total}` +
      `（通过 ${coverage.statuses.passed} / 已改 ${coverage.statuses.revised} / 剔除 ${coverage.statuses.rejected}）` +
      `  ${item.row.title.slice(0, 34)}`,
  );
}
if (gapRows.length > 0) {
  console.log('缺口逐条（回填要点名的就是这些）：');
  for (const item of gapRows) {
    for (const missing of item.coverage.missing) {
      console.log(`  ${item.row.id.slice(0, 8)}  引用：${missing.quote.slice(0, 42)}`);
      console.log(`            推断：${missing.text.slice(0, 42)}`);
    }
  }
}

/** 点名与上限：与前两个工具同一规矩（前缀不唯一/不存在都当场报错，不做"猜一个"）。 */
let picked;
if (idArgs.length > 0) {
  const matched = [];
  const problems = [];
  for (const prefix of idArgs) {
    const hits = gapRows.filter((item) => item.row.id.startsWith(prefix));
    if (hits.length === 0) {
      problems.push(`--ids ${prefix}：没有"以它开头、有判读、且有缺口"的条目`);
      continue;
    }
    if (hits.length > 1) {
      problems.push(`--ids ${prefix}：匹配到 ${hits.length} 条，前缀不唯一（写长一点）`);
      continue;
    }
    matched.push(hits[0]);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✖ ${problem}`);
    console.error('点名的条目有问题，中止（一个字节都没改）');
    process.exit(1);
  }
  picked = matched;
} else {
  // 缺口大的先补（判读数多的条目收益最大）
  picked = [...gapRows].sort((a, b) => b.coverage.missing.length - a.coverage.missing.length);
}

if (picked.length === 0) {
  console.log('\n没有缺口 —— 这一批不用跑。');
  process.exit(0);
}

if (!apply) {
  console.log(
    `\n只读模式（未加 --apply）：这一轮会补 ${picked.length} 条条目，一个字都没改、一次调用都没发。`,
  );
  process.exit(0);
}

const chosen = picked.slice(0, limit === Number.POSITIVE_INFINITY ? picked.length : limit);
console.log(`\n--apply：准备补 ${chosen.length} 条（缺口从大到小）`);

let ok = 0;
let failed = 0;
for (const item of chosen) {
  const { row, impacts } = item;
  // 备份先打出来（stdout 才是权威副本）：写库之前的那一份是谁也回不去的
  console.log(
    `#BACKUP ${JSON.stringify({
      id: row.id,
      previousImpactReviewJson: row.reviewJson,
      backedUpAt: new Date().toISOString(),
    })}`,
  );
  const sources = await draftSourcesForSummary(row);
  const review = await reviewImpactsForSummary({
    target: row,
    impacts,
    sources,
    logger: (line) => console.log(`  ${line}`),
  });
  if (review.diagnostics.status !== 'ok') {
    failed += 1;
    console.log(
      `✖ ${row.id.slice(0, 8)} 审读未成（${review.diagnostics.status}` +
        `${review.diagnostics.error ? `：${review.diagnostics.error}` : ''}）—— 这一条没有写入`,
    );
    continue;
  }
  await saveImpactReviewJson(row.id, serializeImpactReviews(review.records));
  ok += 1;
  console.log(
    `✔ ${row.id.slice(0, 8)} 写入审读记录 ${review.records.length}/${impacts.length} 条` +
      `（通过 ${review.diagnostics.accepted} / 未采信 ${review.diagnostics.rejected}）`,
  );
}

console.log(`\n完成：写入 ${ok} 条，未成 ${failed} 条（未成的那些**没有写库**，下一轮会再试）`);
if (failed > 0) {
  console.error('有没跑成的条目 —— 回填的验收是"缺口为 0"，先把它跑成再放量。');
  process.exit(1);
}
