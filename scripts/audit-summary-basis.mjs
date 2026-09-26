/**
 * 只读审计（issue #83）：AI 摘要的**依据**与**可优化性**分布。
 *
 * 站长的问题（2026-09-26）："AI 摘要残留大量之前的非附件仅公示信息，最好全量取消
 * 或分类为已优化的和未优化的"。这一条命令就是那份"分类"：每条摘要落在哪一档、
 * 为什么、以及**哪些重跑能变好、哪些重跑是白跑**。
 *
 * 判据与页面是同一份纯函数（`src/lib/summary-basis.ts`）：详情页那行「摘要依据：…」
 * 与这里的分桶不可能是两个答案。判定所依据的三样事实都来自库（附件抽取表的行数 /
 * 状态 / `fed_to_summary`，摘要 JSON 的键与三段数组），所以这条审计不需要模型、不改数据。
 *
 * 用法（生产环境，脚本要在 /app 下，否则 `pg` 解析不到）：
 *   docker compose exec -T worker node scripts/audit-summary-basis.mjs
 *   docker compose exec -T worker node scripts/audit-summary-basis.mjs --list   # 列出可优化清单的完整 id
 * 确认要重跑之后用 `scripts/reset-summaries-for-redraft.mjs --apply --ids <8 位前缀,…>`。
 */
import { Client } from 'pg';
import {
  SUMMARY_UPGRADE_LABELS,
  summaryProvenance,
  summaryTemplateOf,
} from '../src/lib/summary-basis.ts';

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const notices = await client.query(
  `select id, source_id, title, status, deadline_at, genre, ai_summary_json, attachments_json
     from notices
    order by deadline_at nulls last, id`,
);
const attachments = await client.query(
  `select notice_id, status, char_count, fed_to_summary from notice_attachments`,
);
await client.end();

const byNotice = new Map();
for (const row of attachments.rows) {
  if (!byNotice.has(row.notice_id)) byNotice.set(row.notice_id, []);
  byNotice.get(row.notice_id).push(row);
}

/** JSON-in-TEXT 解析（坏值按 null 处理，与仓库层 safeParseJson 同一口径）。 */
function parseJson(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const arrayLength = (value) => (Array.isArray(value) ? value.length : 0);

/** 摘要里是否有反查到附件的要点（三栏任一非空）。 */
function hasAttachmentPoints(summary) {
  if (typeof summary !== 'object' || summary === null) return false;
  return (
    arrayLength(summary.keyPoints) > 0 ||
    arrayLength(summary.explanationPoints) > 0 ||
    arrayLength(summary.changes) > 0
  );
}

/**
 * 「条文在哪」的输入，与详情页的算法**逐字同源**（app/notices/[id]/page.tsx）：
 * 抽取表里有行就用它；没有行时，公告自己也没有附件清单才算"没有随文附件"，
 * 否则一律 null（未探测）—— 不能替源站宣布"没有附件"。
 */
function attachmentInputOf(notice, rows) {
  if (rows.length > 0) {
    return {
      total: rows.length,
      okFiles: rows.filter((row) => row.status === 'ok').length,
      fedChars: rows
        .filter((row) => row.fed_to_summary === 1)
        .reduce((sum, row) => sum + (row.char_count ?? 0), 0),
    };
  }
  const listed = arrayLength(parseJson(notice.attachments_json));
  return listed === 0 ? { total: 0, okFiles: 0, fedChars: 0 } : null;
}

const rows = notices.rows.map((notice) => {
  const summary = parseJson(notice.ai_summary_json);
  const provenance = summaryProvenance({
    attachment: attachmentInputOf(notice, byNotice.get(notice.id) ?? []),
    hasAttachmentPoints: hasAttachmentPoints(summary),
    template: summaryTemplateOf(summary),
  });
  return {
    id: notice.id,
    title: notice.title,
    genre: notice.genre,
    status: notice.status,
    deadline: notice.deadline_at,
    hasSummary: summary !== null,
    ...provenance,
  };
});

const withSummary = rows.filter((row) => row.hasSummary);
const countBy = (list, keyOf) => {
  const counts = new Map();
  for (const item of list) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
};

console.log(
  `[audit-summary-basis] 条目 ${rows.length} 条 ｜ 有摘要 ${withSummary.length} ｜ 无摘要 ${rows.length - withSummary.length}`,
);
console.log('  优化状态（运营口径）：');
for (const [state, n] of countBy(withSummary, (row) => row.state)) {
  console.log(`    ${String(n).padStart(3)}  ${SUMMARY_UPGRADE_LABELS[state] ?? state}`);
}
console.log('  内容依据：');
for (const [basis, n] of countBy(withSummary, (row) => `${row.basis}（${row.label}）`)) {
  console.log(`    ${String(n).padStart(3)}  ${basis}`);
}
console.log('  生成模板：');
for (const [template, n] of countBy(withSummary, (row) => row.template)) {
  console.log(`    ${String(n).padStart(3)}  ${template === 'current' ? '当前模板（含编制说明要点）' : '旧模板（无编制说明要点那一栏）'}`);
}

const showList = process.argv.includes('--list');
for (const state of ['upgradable', 'not-upgradable']) {
  const bucket = withSummary.filter((row) => row.state === state);
  const limited = showList ? bucket : bucket.slice(0, 12);
  console.log(`\n=== ${SUMMARY_UPGRADE_LABELS[state]}（${bucket.length} 条）===`);
  for (const row of limited) {
    console.log(
      `  ${row.id.slice(0, 8)}  ${row.basis.padEnd(22)} ${row.template.padEnd(7)} ` +
        `${(row.deadline ?? '无截止').slice(0, 10)}  ${row.title.slice(0, 40)}`,
    );
  }
  if (!showList && bucket.length > limited.length) {
    console.log(`  …另 ${bucket.length - limited.length} 条（加 --list 打印全部）`);
  }
}

const upgradable = withSummary.filter((row) => row.state === 'upgradable');
if (upgradable.length > 0) {
  console.log(
    `\n重跑这些（${upgradable.length} 条）能得到东西，用的命令形状：\n` +
      `  docker compose exec -T worker node scripts/reset-summaries-for-redraft.mjs --apply --ids ${upgradable
        .slice(0, 5)
        .map((row) => row.id.slice(0, 8))
        .join(',')}${upgradable.length > 5 ? ',…' : ''}`,
  );
}
const notUpgradable = withSummary.filter((row) => row.state === 'not-upgradable');
if (notUpgradable.length > 0) {
  console.log(
    `\n另外 ${notUpgradable.length} 条重跑**不会**变好（无附件 / 附件读不到 / 本来就没有条文可摘）——` +
      `\n它们的依据已经在详情页如实标出，别把它们排进重跑队列。`,
  );
}
