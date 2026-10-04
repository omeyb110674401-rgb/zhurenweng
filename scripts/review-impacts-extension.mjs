#!/usr/bin/env node
/**
 * 只读：把**被受众面门控挡住**的判读，按"扩档后读者会看到的样子"打出来（供人工过目）。
 *
 * ## 为什么不能直接用验收门 `show-notice-summary.mjs`
 *
 * 那份量具回答的是"读者**现在**点开这条会看到什么"，所以它走到
 * `shouldRenderImpacts({audience:'sector'}) === false` 就停下，只印一句
 * 「本页不渲染（受众面 sector，只给公众广域）」—— **它按设计不印那几条判读**。
 * 而"L3 要不要扩到行业专业档"这个决定（`88-*.md` §6 第 4 条）只能由人读过那几条判读才拍得下来：
 * 判读说错的代价不是"不准确"而是"误导公众"，所以这一刀的门是**人工过目**，不是"渲染出来了"。
 * 用验收门去过目，等于让人读一串"本页不渲染"。
 *
 * ## 它是什么 / 不是什么
 *
 * - **是**一只量具：把判读按详情页的渲染口径排好（块首概览 + 每条那一行 + 逐字引用 + 出处），
 *   让过目的人**在同一个屏幕上**对照"推断"与"它挂的那句原文"。
 * - **不是**门控的改动：本脚本一行都不改，也不影响页面 —— 它只 SELECT。
 * - **不能**被当成产品：每个条目头上都印着"今天的渲染门 = false"，免得有人把这份清单
 *   读成"页面上已经有了"。
 *
 * ## 与页面同源（本仓第 N 次强调的同一条规矩）
 *
 * `impactOverview` / `impactLine` / `shouldRenderImpacts` / `draftProvenanceLine` /
 * `IMPACT_KIND_LABELS` / `parseQuotedSummary` **全部 import**，不在这里另写一份。
 * 这个文件家族的量具已经因为"自己拼一份"被抓过八次（见 `show-notice-summary.mjs` 头注）——
 * 过目用的清单若与页面不是同一份判据，人读完认可的就不是将来会上线的那一份。
 *
 * 用法（部署了本仓库的容器里，需要 DATABASE_URL；只 SELECT）：
 *   docker compose run --rm worker node scripts/review-impacts-extension.mjs
 *       # 默认 = d 档全集：有判读、但受众面不是公众广域（今天一条都不渲染）
 *   docker compose run --rm worker node scripts/review-impacts-extension.mjs 34d26301 2622a768
 *       # 点名（8 位前缀，可给多个）
 *   docker compose run --rm worker node scripts/review-impacts-extension.mjs --no-quote
 *       # 不印逐字引用（引用是核对的依据，默认印；只在引用很长时用来速览）
 */
import { getDb } from '../src/db/client.ts';
import { notices } from '../src/db/schema/sqlite.ts';
import { isNotNull, ne, sql } from 'drizzle-orm';
import { parseQuotedSummary, IMPACT_KIND_LABELS } from '../src/lib/summary-content.ts';
import { impactLine, impactOverview, impactsToRender } from '../src/lib/impact-display.ts';
import { parseImpactReviews } from '../src/lib/impact-review.ts';
import { draftProvenanceLine } from '../src/lib/summary-display.ts';
import { AUDIENCE_LABELS } from '../src/lib/audience.ts';
import { safeParseJson } from '../src/db/types.ts';

const argv = process.argv.slice(2);
const showQuote = !argv.includes('--no-quote');
const prefixes = argv.filter((arg) => !arg.startsWith('--'));

const db = await getDb();
const rows = await db
  .select({
    id: notices.id,
    title: notices.title,
    url: notices.url,
    audience: notices.audience,
    audienceBasis: notices.audienceBasis,
    status: notices.status,
    deadlineAt: notices.deadlineAt,
    summaryJson: notices.aiSummaryJson,
    // 审读记录（issue #47）：渲染门是选择器，它决定每条渲染哪一份文本 / 有没有被剔除
    reviewJson: notices.impactReviewJson,
  })
  .from(notices)
  // 默认口径 = 「有摘要、且受众面不是公众广域」——判读只能藏在这些人身上。
  // 点名时不过滤受众面（过目的人可能想看某一条到底属于哪一档）。
  .where(
    prefixes.length > 0
      ? isNotNull(notices.aiSummaryJson)
      : sql`${isNotNull(notices.aiSummaryJson)} and (${ne(notices.audience, 'public')} or ${notices.audience} is null)`,
  )
  .orderBy(notices.deadlineAt, notices.id);

/** 点名时按前缀过滤（库内过滤比全部拉回来再筛干净，但前缀匹配只能在应用层做）。 */
const picked =
  prefixes.length > 0
    ? rows.filter((row) => prefixes.some((prefix) => row.id.startsWith(prefix)))
    : rows;

if (picked.length === 0) {
  console.error('没有符合条件的条目（有摘要 + 受众面不是公众广域）。');
  process.exit(1);
}

let withImpacts = 0;
let impactTotal = 0;
let shown = 0;

for (const row of picked) {
  const parsed = parseQuotedSummary(safeParseJson(row.summaryJson));
  if (parsed === null) continue;
  const impacts = parsed.impacts;
  if (impacts.length === 0) continue;
  withImpacts += 1;
  impactTotal += impacts.length;
  shown += 1;

  const audience = row.audience ?? 'unknown';
  const gate =
    impactsToRender({
      audience: row.audience,
      impacts,
      reviews: parseImpactReviews(safeParseJson(row.reviewJson)),
    }) !== null;
  const label = AUDIENCE_LABELS[audience] ?? audience;

  console.log(`\n${'═'.repeat(96)}`);
  console.log(
    `【${shown}】${row.id}  ${label}  库内状态 ${row.status}  截止 ${row.deadlineAt ?? '未标注'}`,
  );
  console.log(`    ${row.title}`);
  if (row.audienceBasis) console.log(`    受众面依据：${row.audienceBasis}`);
  console.log(`    官方原文：${row.url}`);
  console.log(
    `    摘要：这是什么「${parsed.what.text || '（空）'}」；条文要点 ${parsed.keyPoints.length} 条`,
  );
  /**
   * 这一行是这份清单**唯一不可省**的东西：同一批判读，今天的门是 false、扩档后是 true。
   * 少了它，读的人很容易把下面那段读成"页面上已经有了"。
   */
  console.log(
    `    ⚠ 今天的渲染门 impactsToRender ≠ null = ${gate}` +
      `（受众面 ${label}）⇒ 读者**一个字都看不到**；下面这段是"扩档后才会出现"的样子`,
  );

  const overview = impactOverview(impacts);
  console.log('\n    ── 扩档后读者会看到（块首概览与每行都由页面那套纯函数生成）──');
  if (overview.countsLine) console.log(`    ${overview.countsLine}`);
  if (overview.whoLine) console.log(`    ${overview.whoLine}`);
  for (const item of impacts) {
    const line = impactLine(item);
    console.log(
      `\n    • [${IMPACT_KIND_LABELS[item.kind] ?? item.kind}] ` +
        `${line ?? '（未写明影响谁、也没写出哪一方面）'}`,
    );
    console.log(`      推断：${item.text}`);
    if (showQuote) console.log(`      原文：${item.quote}`);
    console.log(`      ${draftProvenanceLine(item.source, '出处：（无出处）')}`);
  }
}

console.log(`\n${'─'.repeat(96)}`);
console.log(
  `共 ${picked.length} 条被读到，其中 ${withImpacts} 条带判读（合计 ${impactTotal} 条判读）。` +
    '本脚本只读：它回答"扩档后读者会多看到什么"，不改变任何门控。',
);
if (withImpacts === 0) {
  console.log('（没有一条带判读 —— 那这个决定今天就不用拍。）');
}
process.exit(0);
