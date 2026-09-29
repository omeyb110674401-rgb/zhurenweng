/**
 * 只读审计（issue #86 §21）：**库里每一条判读 / 要点 / 改动行，今天还追得回官方原文吗**。
 *
 * 为什么值得单独跑一遍：摘要落库那一刻是逐字反查过的（`findDraftSourceForQuote`），
 * 但那之后还有两个变量会动 —— 附件正文被重取过（同一个 URL 换了稿、或抽取实现改过），
 * 以及**早于校验器上线**的存量行。于是"页面上写着逐字提取"这句话要么今天仍成立、
 * 要么是一条我们不知道的假话。这个脚本回答后者：用**与管线同一份判据**重查全库。
 *
 * 判据用的是管线自己的 `findDraftSourceForQuote`（不是我又写一份包含判断）——
 * 要问的是"这一行当初过没过那一关、今天还过不过"，换个判据就答非所问了。
 *
 * 只读：SELECT 三张表，一条都不写。
 * 用法（服务器上）：docker compose run --rm -T worker node scripts/audit-quote-traceability.mjs
 */
import { getDb } from '../src/db/client.ts';
import { notices } from '../src/db/schema/sqlite.ts';
import { listNoticeAttachmentTexts } from '../src/db/repo/attachments.ts';
import { BODY_DRAFT_LABEL, bodyLooksLikeDraft } from '../src/lib/attachment-feed.ts';
import { findDraftSourceForQuote, parseQuotedSummary } from '../src/lib/summary-content.ts';

const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');

function safeParseJson(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const db = await getDb();
const rows = await db
  .select({
    id: notices.id,
    title: notices.title,
    bodyText: notices.bodyText,
    summaryJson: notices.aiSummaryJson,
    summaryModel: notices.summaryModel,
  })
  .from(notices)
  .orderBy(notices.id);

let scanned = 0;
let rowsChecked = 0;
const bySection = new Map();
const failures = [];

for (const row of rows) {
  if (row.summaryJson === null) continue;
  scanned += 1;
  const attachments = await listNoticeAttachmentTexts(row.id);
  const bodyAsDraft = bodyLooksLikeDraft(row.bodyText ?? '');
  const sources = [
    ...attachments.map((item) => ({ name: item.name, url: '', text: item.text })),
    ...(bodyAsDraft ? [{ name: BODY_DRAFT_LABEL, url: '', text: row.bodyText ?? '' }] : []),
  ];
  if (sources.length === 0) continue;

  const summary = parseQuotedSummary(safeParseJson(row.summaryJson));
  const sections = [
    ['条文要点', summary.keyPoints],
    ['影响判读', summary.impacts],
    ['改动行', summary.changes],
    ['说明要点', summary.explanationPoints],
  ];
  for (const [name, items] of sections) {
    const tally = bySection.get(name) ?? { total: 0, traced: 0 };
    for (const item of items) {
      tally.total += 1;
      rowsChecked += 1;
      const source = findDraftSourceForQuote(item.quote ?? null, sources);
      if (source !== null) {
        tally.traced += 1;
      } else if (name === '说明要点') {
        // 说明要点的引用取自说明附件，出处那一列另行显示；这里同样按全池查
        failures.push({ id: row.id, section: name, quote: item.quote ?? '', title: row.title });
      } else {
        failures.push({ id: row.id, section: name, quote: item.quote ?? '', title: row.title });
      }
    }
    bySection.set(name, tally);
  }
}

console.log('== 逐字可回溯审计（全库，只读）==');
console.log(`有摘要的条目 ${scanned} 条 ｜ 查了 ${rowsChecked} 行（条文要点 / 影响判读 / 改动行 / 说明要点）`);
for (const [name, tally] of bySection) {
  const bad = tally.total - tally.traced;
  console.log(
    `  ${name}：${tally.traced}/${tally.total} 逐字可回溯` + (bad > 0 ? `  ⚠️ ${bad} 行对不上` : ''),
  );
}
console.log(`\n对不上的行共 ${failures.length} 行`);
const shown = verbose ? failures : failures.slice(0, 25);
for (const failure of shown) {
  console.log(
    `  ✗ [${failure.section}] ${failure.id} ${failure.title.slice(0, 34)} —— ` +
      `${(failure.quote || '（空引用）').slice(0, 90)}`,
  );
}
if (!verbose && failures.length > shown.length) {
  console.log(`  ……还有 ${failures.length - shown.length} 行（加 --verbose 全打）`);
}
console.log('\n（本审计只读：一个字都没写库）');
