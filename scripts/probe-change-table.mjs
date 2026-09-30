/**
 * 只读探针（issue #86 第二十节第 3 小节的收尾）：把**新版**那张"行由程序定"的表
 * 拿生产库里的真条目算出来，与**落库那一版**（模型写出的行）并排打印。
 *
 * 为什么在一个只读探针里跑生产数据：`buildChangeTable` 的输入是"数分母用的那一份文本"，
 * 而那份文本是 worker 在**运行时**拼的（全部附件正文 + 正文本身就是条文时再接正文）。
 * 单测只能拿夹具钉形状；这份探针回答的是另一件事 —— **线上那几条真条目会变成几行**，
 * 以及新表会不会把落库那一版的行弄丢。后者是这次改动唯一可能伤到读者的地方。
 *
 * 判据一律 import 管线自己的实现（`feedPlanForSummary` 判"正文算不算条文"、
 * `buildChangeTable` 定行、`changeTableNote` 写交代），脚本里不另写一份 ——
 * 早些时候那一版探针就是自己拿 `bodyLooksLikeDraft(bodyText)` 近似的，与 worker 的
 * `draftSources.some(origin === 'body')` 不是同一个判据（同样的输入可能数出不同的分母）。
 *
 * 只读：一条都不写库。用法（服务器上，源码从 /tmp/zw-probe 挂进来）：
 *   docker compose run --rm -T worker node scripts/probe-change-table.mjs            # 未截止的公众广域
 *   docker compose run --rm -T worker node scripts/probe-change-table.mjs --all      # 有摘要的全部
 *   docker compose run --rm -T worker node scripts/probe-change-table.mjs --id 9bd57185
 */
import { getDb } from '../src/db/client.ts';
import { notices } from '../src/db/schema/sqlite.ts';
import { sql } from 'drizzle-orm';
import { listNoticeAttachmentTexts } from '../src/db/repo/attachments.ts';
import { feedPlanForSummary } from '../worker/jobs/summarize-notices.ts';
import { parseQuotedSummary } from '../src/lib/summary-content.ts';
import { buildChangeTable, changeTableCounts, sentenceSpans } from '../src/lib/change-table.ts';
import { changeFactNote, changeTableNote, countChangeMarkers, findChangeMarkers } from '../src/lib/change-coverage.ts';
import { draftProvenanceLine } from '../src/lib/summary-display.ts';
import { AUDIENCE_LABELS } from '../src/lib/audience.ts';
import { safeParseJson } from '../src/db/types.ts';

const argv = process.argv.slice(2);
const idIndex = argv.indexOf('--id');
const prefix = idIndex === -1 ? null : (argv[idIndex + 1] ?? null);
const all = argv.includes('--all');
const limitIndex = argv.indexOf('--limit');
const limit = limitIndex === -1 ? 200 : Number(argv[limitIndex + 1]) || 200;

const db = await getDb();
const rows = await db
  .select({
    id: notices.id,
    title: notices.title,
    url: notices.url,
    bodyText: notices.bodyText,
    audience: notices.audience,
    genre: notices.genre,
    sourceId: notices.sourceId,
    deadlineAt: notices.deadlineAt,
    summaryJson: notices.aiSummaryJson,
  })
  .from(notices)
  .where(
    prefix !== null
      ? sql`1 = 1`
      : all
        ? sql`ai_summary_json is not null`
        : sql`ai_summary_json is not null and audience = 'public' and deadline_at >= to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD')`,
  )
  .orderBy(notices.id)
  .limit(400);

const targets = rows
  .filter((row) => (prefix === null ? true : row.id.startsWith(prefix)))
  .slice(0, limit);

/** 每一档的规模分布：这张表在真语料上到底几行（换体裁、换条目长度都要看） */
const histogram = new Map();
let checked = 0;
let withMarkers = 0;
let lostRows = 0;

for (const row of targets) {
  const parsed = parseQuotedSummary(safeParseJson(row.summaryJson));
  if (!parsed) continue;
  checked += 1;

  // 与 worker 同一个入口：它判"正文算不算条文"，也给出这一轮真正喂进去的清单
  const plan = await feedPlanForSummary({
    id: row.id,
    title: row.title,
    url: row.url,
    bodyText: row.bodyText,
    sourceId: row.sourceId,
    genre: row.genre,
    audience: row.audience,
  });
  const bodyAsDraft = plan.sources.some((source) => source.origin === 'body');
  const fullTexts = await listNoticeAttachmentTexts(row.id);
  const changeText = [
    ...fullTexts.map((item) => item.text),
    ...(bodyAsDraft ? [row.bodyText ?? ''] : []),
  ].join(' ');

  const markers = countChangeMarkers(changeText);
  const table = buildChangeTable(changeText, parsed.changes);
  const entries = table.entries;
  const { described, factOnly } = changeTableCounts(entries);
  // **这一次改动唯一可能伤到读者的地方**：新表会不会把落库那一版的行弄丢
  const before = parsed.changes.length;
  const after = described;
  if (after !== before) lostRows += 1;
  if (markers.total > 0) withMarkers += 1;
  const key = `${entries.length}行`;
  histogram.set(key, (histogram.get(key) ?? 0) + 1);

  const interesting = prefix !== null || markers.total > 0;
  if (!interesting) continue;

  console.log(`\n${'='.repeat(96)}`);
  console.log(`${row.id}  ${AUDIENCE_LABELS[row.audience] ?? row.audience ?? '未判定'}  截止 ${row.deadlineAt}`);
  console.log(`  ${row.title}`);
  console.log(
    `  分母来源：附件 ${fullTexts.length} 份${bodyAsDraft ? ' + 正文' : ''}` +
      ` ｜ 改动表述 ${markers.total} 处 ｜ 落库的改动表 ${before} 行`,
  );
  console.log(`  ${changeTableNote({ markers: markers.total, rows: entries.length, described, factOnly, headers: table.headers }).detail}`);
  console.log(
    `  句子核对：带改动表述的句子 ${sentenceSpans(changeText).filter((span) => {
      const sentence = changeText.slice(span.start, span.end).trim();
      return sentence !== '' && findChangeMarkers(sentence).length > 0;
    }).length} 句 ｜ 表 ${entries.length} 行 + 标题 ${table.headers} 句`,
  );
  for (const entry of entries) {
    if (entry.type === 'fact') {
      console.log(
        `   • ${entry.clause || '—'} ｜（${entry.kinds.join('+')}）｜ ${changeFactNote(entry)}`,
      );
      console.log(`     原文：${entry.sentence.slice(0, 120)}${entry.sentence.length > 120 ? '…' : ''}`);
      continue;
    }
    const change = parsed.changes[entry.change];
    if (!change) {
      console.log(`   • ⚠ 表里指向第 ${entry.change} 行，而落库只有 ${before} 行（下标越界）`);
      continue;
    }
    console.log(`   • ${change.clause || '—'} ｜ ${change.kind} ｜ ${change.text}`);
    console.log(`     原文：${change.quote}`);
    console.log(`     ${draftProvenanceLine(change.source, '出处：（无出处）')}`);
  }
  if (after !== before) console.log(`   ⚠ 落库 ${before} 行、新表只安置了 ${after} 行 —— 有说明会从页面上消失`);
}

console.log(`\n${'='.repeat(96)}`);
console.log(`查了 ${checked} 条有摘要的条目 ｜ 其中 ${withMarkers} 条数到了改动表述 ｜ 行数分布：`);
for (const [key, count] of [...histogram.entries()].sort((a, b) => Number.parseInt(a[0]) - Number.parseInt(b[0]))) {
  console.log(`   ${key} × ${count} 条`);
}
console.log(
  lostRows === 0
    ? '✅ 每一条落库的说明行都在新表里找到了位置（0 条丢失）'
    : `⚠ ${lostRows} 条有条目丢了说明行 —— 这就是不能上线的理由`,
);
console.log('（本探针只读：一个字都没写库）');
process.exit(0);
