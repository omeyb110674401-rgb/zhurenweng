/**
 * 只读审计（issue #86 第 0 刀）：摘要调用的诊断 —— **模型吐了什么、我们丢了什么、丢在哪一关**。
 *
 * 为什么要单独一条命令：删掉的「改动点」连续两轮零产出，而事后没有任何人能回答它是
 * "模型返回了空数组"还是"引用没通过逐字反查被丢掉"（#79 把这句话写进了文档就停在那里）。
 * 这两件事的处置完全相反（换模型 vs 改校验/改提示词），所以每一次提示词改动之前，
 * 先跑这条命令看基线，改完再跑一次看差值 —— 否则改了提示词只能凭感觉说"好像好一点"。
 *
 * 它读的是 `notices.summary_diagnostics_json`（形状见 src/lib/summary-diagnostics.ts），
 * 与摘要本体一起落库。**只读**：仅 SELECT。阈值与解读口径都不在这里另写一份。
 *
 * 用法（生产环境，脚本要在 /app 下，否则 `pg` 解析不到）：
 *   docker compose exec -T worker node scripts/audit-summary-diagnostics.mjs
 *   docker compose exec -T worker node scripts/audit-summary-diagnostics.mjs --drops
 *   docker compose exec -T worker node scripts/audit-summary-diagnostics.mjs --id 9bd57185 --raw
 */
import { Client } from 'pg';
import { describeDiagnostics, parseSummaryDiagnostics } from '../src/lib/summary-diagnostics.ts';

const argv = process.argv.slice(2);
const onlyDrops = argv.includes('--drops');
const withRaw = argv.includes('--raw');
const showAll = argv.includes('--all');
const idIndex = argv.indexOf('--id');
const idPrefix = idIndex === -1 ? null : (argv[idIndex + 1] ?? '');

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows } = await client.query(
  `select id, title, status, summary_status, summary_model, ai_summary_json, summary_diagnostics_json
     from notices
    where ai_summary_json is not null
    order by deadline_at nulls last, id`,
);
await client.end();

/** 有摘要的行里，诊断列到底有没有东西 —— "键在不在"与"值是多少"是两回事（#82 的教训）。 */
const withDiagnostics = [];
let missingColumn = 0;
for (const row of rows) {
  if (row.summary_diagnostics_json === null || row.summary_diagnostics_json === undefined) {
    missingColumn += 1;
    continue;
  }
  const parsed = parseSummaryDiagnostics(
    (() => {
      try {
        return JSON.parse(row.summary_diagnostics_json);
      } catch {
        return null;
      }
    })(),
  );
  if (parsed === null) {
    missingColumn += 1;
    continue;
  }
  withDiagnostics.push({ row, diagnostics: parsed });
}

const filtered = withDiagnostics.filter((item) => {
  if (idPrefix !== null && !item.row.id.startsWith(idPrefix)) return false;
  if (!onlyDrops) return true;
  const d = item.diagnostics.dropped;
  return d.quoteNotFound + d.emptyOrInvalid + d.overLimit > 0;
});

console.log(
  `[audit-summary-diagnostics] 有摘要 ${rows.length} 条 ｜ 带着诊断 ${withDiagnostics.length} 条 ｜ ` +
    `没有诊断 ${missingColumn} 条（本列上线前的存量，或人工复核手工录入的）`,
);

const instrumented = withDiagnostics.filter((item) => item.diagnostics.instrumented).length;
console.log(
 `  端口上报了响应细节的：${instrumented} 条；未上报的：${withDiagnostics.length - instrumented} 条`
  + `（未上报时只有"落库几条"可信，见 instrumented 的注释）`,
);

if (withDiagnostics.length > 0) {
  const sum = (pick) => withDiagnostics.reduce((total, item) => total + pick(item.diagnostics), 0);
  const quoteNotFound = sum((d) => d.dropped.quoteNotFound);
  const emptyOrInvalid = sum((d) => d.dropped.emptyOrInvalid);
  const overLimit = sum((d) => d.dropped.overLimit);
  const anyDrop = withDiagnostics.filter(
    (item) => item.diagnostics.dropped.quoteNotFound + item.diagnostics.dropped.emptyOrInvalid + item.diagnostics.dropped.overLimit > 0,
  ).length;
  console.log(
    `\n== 丢弃合计（${anyDrop} 条至少丢了一样）==\n` +
      `  反查不到出处 quoteNotFound .... ${quoteNotFound}   ← 提示词/校验器/输入窗口，三者之一\n` +
      `  空或类型不对 emptyOrInvalid ... ${emptyOrInvalid}   ← 提示词的字段说明\n` +
      `  超条数上限 overLimit .......... ${overLimit}   ← 上限该调，或模型在凑数`,
  );

  const emitted = sum((d) => d.emitted.keyPoints + d.emitted.explanationPoints);
  const kept = sum((d) => d.kept.keyPoints + d.kept.explanationPoints);
  console.log(
    `\n== 要点留存率 ==\n  模型吐出 ${emitted} 条 ⇒ 落库 ${kept} 条` +
      `（留存 ${emitted === 0 ? '—（一条都没吐）' : `${Math.round((kept / emitted) * 100)}%`}）`,
  );

  const byModel = new Map();
  for (const item of withDiagnostics) {
    const key = item.diagnostics.model || '(未上报)';
    if (!byModel.has(key)) byModel.set(key, { count: 0, elapsed: 0, timed: 0, attempts: 0 });
    const bucket = byModel.get(key);
    bucket.count += 1;
    if (item.diagnostics.elapsedMs !== null) {
      bucket.elapsed += item.diagnostics.elapsedMs;
      bucket.timed += 1;
    }
    if (item.diagnostics.attempts > 1) bucket.attempts += 1;
  }
  console.log('\n== 分模型 ==');
  for (const [model, bucket] of byModel) {
    console.log(
      `  ${model.padEnd(24)} ${String(bucket.count).padStart(4)} 条` +
        `  平均 ${bucket.timed === 0 ? '—' : `${(bucket.elapsed / bucket.timed / 1000).toFixed(1)}s`}` +
        `  重试过 ${bucket.attempts} 条`,
    );
  }
}

const limit = showAll || idPrefix !== null ? filtered.length : 40;
console.log(`\n== 清单（${filtered.length} 条${filtered.length > limit ? `，只打前 ${limit} 条，加 --all 看全部` : ''}）==`);
for (const item of filtered.slice(0, limit)) {
  console.log(`  ${item.row.id.slice(0, 8)}  ${describeDiagnostics(item.diagnostics)}`);
  console.log(`            ${String(item.row.title).slice(0, 52)}`);
  if (withRaw && item.diagnostics.raw !== '') {
    console.log(`            ── 模型原始输出（${item.diagnostics.rawChars} 字${item.diagnostics.rawTruncated ? '，已截断' : ''}）──`);
    console.log(item.diagnostics.raw);
  }
}
