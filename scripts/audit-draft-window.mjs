#!/usr/bin/env node
/**
 * 只读诊断（issue #67）：**摘要任务到底看到了附件的哪一段**。
 *
 * 为什么需要它：#67 放量后 49 条里有 6 条 `keyPoints` 是空的。5 条能当场解释掉（附件是
 * 委员名单 / 立项申报书 / 标准制修订计划表 —— 里面本来就没有规范性条文），但有一条不行：
 * 附件抽出了 48,543 字，模型还是没给出任何可逐字核对的要点。"没产出"有三种完全不同的原因
 * —— ① 内容里确实没条文；② 有条文但 `excerptForPrompt` 的截取窗口没带进来；③ 窗口带进来了
 * 而模型没引用 —— 只有第一种不需要动代码，而后两种要修的东西完全不同。光看库里的字数看不出来，
 * 必须把**真正送进提示词的那一截**打出来。
 *
 * 判据一律复用摘要任务自己的 `draftSourcesForSummary()`（同一份门槛、预算与档位），
 * 脚本里不重写选取逻辑 —— 重写了就等于在诊断一个与生产不同的实现。
 *
 * 用法（在部署了本仓库的容器里跑，需要 DATABASE_URL；只 SELECT）：
 *   docker compose run --rm worker node scripts/audit-draft-window.mjs <noticeId> [<noticeId> …]
 *   docker compose run --rm worker node scripts/audit-draft-window.mjs --no-points   # 自动取"有摘要却没可核对要点"的条目
 *   docker compose run --rm worker node scripts/audit-draft-window.mjs <id> --head 400
 */
import { getDb } from '../src/db/client.ts';
import { notices } from '../src/db/schema/sqlite.ts';
import { inArray, sql } from 'drizzle-orm';
import { draftSourcesForSummary } from '../worker/jobs/summarize-notices.ts';
import { countCjk } from '../src/lib/attachment-select.ts';
import { parseQuotedSummary } from '../src/lib/summary-content.ts';
import { safeParseJson } from '../src/db/types.ts';

const argv = process.argv.slice(2);
const headIndex = argv.indexOf('--head');
const HEAD_CHARS = headIndex >= 0 ? Number(argv[headIndex + 1]) || 200 : 200;
// 位置参数全是 noticeId（16 位十六进制，可能恰好全是数字 ⇒ 不能按形状筛，只能跳过选项与它的值）
const ids = [];
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--head') {
    i += 1;
    continue;
  }
  if (!arg.startsWith('--')) ids.push(arg);
}

const ANCHOR = /第[一二三四五六七八九十百0-9]{1,4}条/g;
/** 规范性句子的粗略形状（"应 / 不应 / 不得 / 须 / 应当 / 本标准规定了"），用于判断窗口里有没有可摘的东西 */
const NORMATIVITY =
  /应[当不]?|不得|须|严禁|宜采?用|本标准规定|技术要求|应符合/g;

const db = await getDb();

if (ids.length === 0 && !argv.includes('--no-points')) {
  console.error('给至少一个 noticeId，或用 --no-points 自动取"有摘要却没可核对要点"的条目');
  process.exit(1);
}

const targets =
  ids.length > 0
    ? await db
        .select({ id: notices.id, title: notices.title, summaryJson: notices.aiSummaryJson })
        .from(notices)
        .where(inArray(notices.id, ids))
    : await db
        .select({ id: notices.id, title: notices.title, summaryJson: notices.aiSummaryJson })
        .from(notices)
        .where(sql`ai_summary_json is not null and status <> 'closed'`)
        .orderBy(notices.id);

let scanned = 0;
for (const row of targets) {
  const parsed = parseQuotedSummary(safeParseJson(row.summaryJson));
  const sourcePoints = parsed
    ? parsed.keyPoints.filter((p) => typeof p.source === 'string' && p.source !== '').length
    : 0;
  // --no-points 只要"没产出可核对要点"的那些（就是本次要查的对象）
  if (argv.includes('--no-points') && sourcePoints > 0) continue;
  scanned += 1;

  console.log(`\n=== ${row.id}  要点带出处 ${sourcePoints} 条`);
  console.log(`    ${row.title}`);

  const sources = await draftSourcesForSummary({
    id: row.id,
    title: row.title,
    url: '',
    bodyText: null,
    sourceId: '',
  });
  if (sources.length === 0) {
    console.log('    送进提示词的条文：0 份（附件没抽出来 / 没过 400 字门槛 / 正文够长不走附件）');
    continue;
  }
  for (const source of sources) {
    const anchors = (source.text.match(ANCHOR) ?? []).length;
    const normative = (source.text.match(NORMATIVITY) ?? []).length;
    const head = source.text.replace(/\s+/g, ' ').slice(0, HEAD_CHARS);
    console.log(
      `    窗口：${source.name}  送入 ${source.text.length} 字符 / ${countCjk(source.text)} 汉字；` +
        `第X条 ${anchors} 处，规范性字样 ${normative} 处`,
    );
    console.log(`      开头：${head}`);
  }
}
console.log(`\n共看 ${scanned} 条。送入窗口里没有「第X条」也不等于没条文可摘`
  + '（线上实测：29 条无锚点条目照样产出可核对要点），判"该不该有要点"要用页面上的引用能不能逐字对上。');
process.exit(0);
