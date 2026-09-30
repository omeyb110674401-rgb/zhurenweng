#!/usr/bin/env node
/**
 * 只读：把**已落库**的摘要按详情页会渲染的样子打出来（issue #86 第十五节第 6 步）。
 *
 * 为什么要有它：用户拍板的验收门是"人工过一遍那几条判读与改动表"，而读的必须是
 * **库里真实落下的产物** —— 探针（`scripts/probe-public-impacts.mjs`）打印的是"如果现在部署
 * 读者会看到什么"，那是**部署前**的预演，不能当验收证据。
 *
 * 与页面同源的三处判据一律 import，脚本里不重写：
 *   - `shouldRenderImpacts`（给谁看 / 空则不渲染）
 *   - `draftProvenanceLine`（「出处」那一行按来路分开写。**2026-09-28 补**：脚本原先自己
 *     拼 `附件《<来源>》`，于是"正文就是条文"那类条目在这里被印成
 *     `附件《本页正文（公告里直接给出的条文）》` —— 页面是对的、量具在说谎，
 *     正是 #82/#85/#86 反复出现的那一族，第六次）
 *   - `changeCoverageVerdict`（"还差多少"那三句话）
 *   - `changeTableNote`（第二十节第 3 小节起：表由程序定行，这一句交代几行有说明、几行只报事实。
 *     **2026-09-28 补**：表换成"行由程序定"之后，这个脚本必须跟着换 —— 它印的是
 *     "读者点开这条会看到什么"，印一张旧形状的表就是这只量具第八次说谎）
 *   - `explanationCoverageVerdict`（§19.4 收尾起也印：这一栏此前**只印要点、不印那句覆盖度**，
 *     于是"页面在说'其余的不在本站读到的那一截里'"这件事，验收门上看不见）
 *   - `parseQuotedSummary`（读侧容错：`impacts` / `changes` / `changeMarkers` 三个键都由它
 *     按旧落库形状兜底，判形状异常会让存量条目白屏 —— #85 第三节的教训）
 *
 * **这三句交代都要带上本轮的喂入清单**（`summary_diagnostics_json.feed`，§19.4）：它们现在
 * 说"差额能归给谁"靠的就是它。脚本从落库的诊断里读同一份清单再交给同一批判据，
 * 页面怎么印它就怎么印 —— 门与页面不一致，这只量具就又开始说谎了。
 *
 * 用法（部署了本仓库的容器里，需要 DATABASE_URL；只 SELECT）：
 *   docker compose run --rm worker node scripts/show-notice-summary.mjs                    # 未截止的公众广域
 *   docker compose run --rm worker node scripts/show-notice-summary.mjs <id 前缀> [<id>…]  # 点名
 *   docker compose run --rm worker node scripts/show-notice-summary.mjs --all-open         # 未截止的全部受众面
 */
import { getDb } from '../src/db/client.ts';
import { notices } from '../src/db/schema/sqlite.ts';
import { inArray, sql } from 'drizzle-orm';
import {
  parseQuotedSummary,
  IMPACT_KIND_LABELS,
} from '../src/lib/summary-content.ts';
import { shouldRenderImpacts } from '../src/lib/impact-display.ts';
import { changeCoverageVerdict, changeFactNote, changeTableNote } from '../src/lib/change-coverage.ts';
import { explanationCoverageVerdict } from '../src/lib/explanation-coverage.ts';
import { changeTableCounts, changeTableRows } from '../src/lib/change-table.ts';
import { draftProvenanceLine } from '../src/lib/summary-display.ts';
import { parseSummaryDiagnostics, describeDiagnostics } from '../src/lib/summary-diagnostics.ts';
import { AUDIENCE_LABELS } from '../src/lib/audience.ts';
import { safeParseJson } from '../src/db/types.ts';

const argv = process.argv.slice(2);
const ids = argv.filter((arg) => !arg.startsWith('--'));
const allOpen = argv.includes('--all-open');

const db = await getDb();
const rows = await db
  .select({
    id: notices.id,
    title: notices.title,
    audience: notices.audience,
    deadlineAt: notices.deadlineAt,
    summaryJson: notices.aiSummaryJson,
    diagnosticsJson: notices.summaryDiagnosticsJson,
  })
  .from(notices)
  .where(
    ids.length > 0
      ? inArray(notices.id, ids)
      : allOpen
        ? sql`ai_summary_json is not null and deadline_at >= to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD')`
        : sql`ai_summary_json is not null and audience = 'public' and deadline_at >= to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD')`,
  )
  .orderBy(notices.deadlineAt, notices.id);

if (rows.length === 0) {
  console.error('没有符合条件的条目（有摘要 + 未截止 + 受众面）。');
  process.exit(1);
}

for (const row of rows) {
  const raw = safeParseJson(row.summaryJson);
  const parsed = parseQuotedSummary(raw);
  console.log(`\n${'='.repeat(96)}`);
  console.log(`${row.id}  ${AUDIENCE_LABELS[row.audience] ?? row.audience ?? '未判定'}  截止 ${row.deadlineAt}`);
  console.log(`    ${row.title}`);
  if (!parsed) {
    console.log('  ⚠ 这一行的 ai_summary_json 解析不了（详情页会退成"待人工复核"占位）');
    continue;
  }

  const diagnostics = parseSummaryDiagnostics(safeParseJson(row.diagnosticsJson));
  console.log(`  摘要：条文要点 ${parsed.keyPoints.length} / 说明要点 ${parsed.explanationPoints.length} 条`);
  if (diagnostics) console.log(`  诊断：${describeDiagnostics(diagnostics)}`);
  /**
   * 本轮的喂入清单（issue #86 §19.4）：下面三句覆盖度交代都要它才说得出"差额能归给谁"。
   * 页面走的是同一条路（`getNoticeSummary` → `parseSummaryDiagnostics(...).feed`），
   * 这里读不出来就是 null —— 判据会退回"没有留下喂入记录"，与页面逐字一致。
   */
  const feed = diagnostics?.feed ?? null;

  // 「可能的争议点」——渲染门控与页面同一份判据
  const impacts = parsed.impacts;
  if (shouldRenderImpacts({ audience: row.audience, impacts })) {
    console.log('\n  ── 可能的争议点（本站 AI 推断，非官方表述，可能错） ──');
    for (const item of impacts) {
      console.log(`   • [${IMPACT_KIND_LABELS[item.kind] ?? item.kind}] ${item.who || '（未写明影响谁）'}：${item.text}`);
      console.log(`     引用：${item.quote}`);
      console.log(`     ${draftProvenanceLine(item.source, '出处：（无出处）')}`);
    }
  } else if (impacts.length > 0) {
    console.log(`\n  ── 可能的争议点：本页不渲染（受众面 ${row.audience ?? '未判定'}，只给公众广域） ──`);
  } else {
    console.log('\n  ── 可能的争议点：本页不渲染（一条都没有） ──');
  }

  // 「改了哪几处」——表 + 交代那一句（与页面同源：`changeTableNote` / `changeCoverageVerdict`
  // 都是 import 的，脚本不另写一份 —— 这个脚本是验收门，它印的必须是**读者真会看到的**）
  const changes = parsed.changes;
  const markers = parsed.changeMarkers;
  const table = parsed.changeTable;
  const entries = changeTableRows(changes, table);
  if (entries.length > 0) {
    const { described, factOnly } = changeTableCounts(entries);
    console.log('\n  ── 改了哪几处 ──');
    if (table !== null && markers) {
      console.log(
        `     ${changeTableNote(
          {
            markers: markers.total,
            rows: entries.length,
            described,
            factOnly,
            headers: table.headers,
          },
          feed,
        ).detail}`,
      );
    } else if (markers) {
      console.log(`     ${changeCoverageVerdict(changes.length, markers, feed).detail}`);
    } else {
      console.log('     （这一行的改动表述计数没落库，给不出"还差多少"）');
    }
    for (const entry of entries) {
      if (entry.type === 'fact') {
        console.log(
          `   • ${entry.clause || '—'} ｜ ${entry.kinds.join('+') || '—'} ｜ ${changeFactNote(entry)}`,
        );
        console.log(`     原文（本句）：${entry.sentence}`);
        continue;
      }
      const item = changes[entry.change];
      if (!item) continue;
      console.log(`   • ${item.clause || '—'} ｜ ${item.kind} ｜ ${item.text}`);
      console.log(`     原文：${item.quote}`);
      console.log(`     ${draftProvenanceLine(item.source, '出处：（无出处）')}`);
    }
  } else {
    console.log('\n  ── 改了哪几处：整块不渲染（一行都没有） ──');
    if (markers && markers.total > 0) {
      console.log(`     注意：全文里检测到 ${markers.total} 处改动表述，却一行都没列出来`);
    }
  }

  if (parsed.explanationPoints.length > 0) {
    console.log(`\n  ── 编制说明要点 ${parsed.explanationPoints.length} 条 ──`);
    // 那一句覆盖度页面会印（`summary-explanation-coverage`），§19.4 收尾起这里也印：
    // 验收门看不到它，就等于没人看过页面那一行说了什么。判据与页面同一份 import。
    if (parsed.explanationSections !== null) {
      console.log(
        `     ${explanationCoverageVerdict(
          parsed.explanationPoints.length,
          parsed.explanationSections,
          feed,
        ).detail}`,
      );
    }
    for (const item of parsed.explanationPoints) console.log(`   • ${item.heading}：${item.text}`);
  }
}

console.log(`\n共 ${rows.length} 条。本脚本只读：它回答"读者现在点开这条会看到什么"。`);
process.exit(0);
