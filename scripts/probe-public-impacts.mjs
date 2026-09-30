/**
 * 实验探针（issue #86 第十三节）：**部署之前**，把新管线在真实的「公众广域」条目上跑一遍，
 * 打印"读者到底会看到什么"，一次库都不写。
 *
 * 为什么要有它：第 1/2/3 刀全部落地但**未部署**，而三件事都还没有任何生产证据 ——
 * ① 影响判读（「可能的争议点」）站不站得住（失败模式是**误导公众**，不是"不准确"）；
 * ② 「改了哪几处」在真附件上的产出率（此前只有一次单条实验，且用的是旧提示词）；
 * ③ 重档的代价（输入翻倍后的耗时与 token）。用户拍板的"人工过一遍"要读的正是这份输出。
 *
 * **它不自己拼提示词、也不自己写校验**：走 `createLlmPort()`（生产那一份适配器）与
 * `buildQuotedSummaryWithTally()`（worker 落库前用的同一份实现）。探针另写一份"差不多的
 * 输入/判据"会让结论只对这份探针成立 —— 而"探针看到的与生产不是同一份"正是 #79 卡住的原因。
 *
 * **只读**：仅 SELECT；不调用任何写库函数、不改文件、不碰线上摘要。
 * 模型调用走当轮环境变量里的服务商（生产容器里那一份），因此**会产生真实调用**（免费档，约 1 分钟/条）。
 *
 * 用法（生产容器内跑；挂载清单写在 `deploy/run-probe-public-impacts.sh` 里，
 * 那个脚本只读挂载本轮改过的 src/worker 文件 —— 不挂就是跑镜像里那份旧代码，
 * **而旧代码的产出会被读成"新管线的产出"**）：
 *
 *   # 1. 把这些文件推到服务器的临时目录（不要覆盖 /opt/zhurenweng，那是"同步 ≠ 部署"的坑）
 *   # 2. sh /tmp/zw-probe/deploy/run-probe-public-impacts.sh   （后台跑，输出到 /tmp/zw-probe/out.txt）
 *   # 3. 轮询 tail /tmp/zw-probe/out.txt
 *
 *   --id <前缀>   只跑一条（点名复核用）
 *   --limit N     最多跑几条（缺省 3）
 *   --no-raw      不打印模型原始输出（它可能很长）
 */
import { Client } from 'pg';
import { createLlmPort } from '../src/lib/ports.ts';
import { feedPlanForSummary } from '../worker/jobs/summarize-notices.ts';
import { buildQuotedSummaryWithTally, llmModelName, findDraftSourceForQuote, quoteSegments, MIN_VERIFIABLE_QUOTE_CHARS } from '../src/lib/summary-content.ts';
import { countChangeMarkers, changeCoverageVerdict } from '../src/lib/change-coverage.ts';
import { countExplanationSections } from '../src/lib/explanation-coverage.ts';
import { attachmentRole } from '../src/lib/attachment-select.ts';
import { effectiveStatus } from '../src/lib/notice-status.ts';
import { draftProvenanceLine } from '../src/lib/summary-display.ts';
import { buildSummaryDiagnostics, describeDiagnostics } from '../src/lib/summary-diagnostics.ts';

const argv = process.argv.slice(2);
const idIndex = argv.indexOf('--id');
const idPrefix = idIndex === -1 ? null : (argv[idIndex + 1] ?? null);
const limitIndex = argv.indexOf('--limit');
const limit = limitIndex === -1 ? 3 : Number(argv[limitIndex + 1]) || 3;
const showRaw = !argv.includes('--no-raw');
/**
 * `--drops`：把**被逐字反查丢掉**的那些改动行逐段拆开，指出它死在哪一段。
 *
 * 为什么需要它（2026-09-30 的分布实验）：同一条公路法跑三遍，改动行落库数是
 * **8 / 5 / 2**，而"反查丢掉"分别是 1 / 4 / 7 —— 丢掉的是**说明**（页面上那一行只剩
 * 「本站检测到这一处改动表述，但没能给出可核对的说明」）。也就是说这张表的主要损失
 * 不在"模型没写"，而在"写出来的引没过关"，而此前**没有任何量具**能回答"为什么没过关"。
 *
 * 判据**复用管线自己那一份**（`findDraftSourceForQuote` 与 `quoteSegments`），
 * 做法是把每一段单独当成一条引用再查一次 —— 单段引用若查得到就说明这一段没问题，
 * 于是"死在哪一段、是短于 8 字还是文字对不上"一眼可见。**不在这里另写一套包含判断**：
 * 两套判据漂移的话，这个探针就会开始解释一个不存在的死因。
 */
const showDrops = argv.includes('--drops');

if (!process.env.DATABASE_URL) {
  console.error('需要 DATABASE_URL（这个探针要在部署了本仓库的容器里跑，它读的是生产库）');
  process.exit(1);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

// 只读：未截止的公众广域条目就是用户拍板的"人工过一遍"那一批（`/?audience=public`）
const candidates = idPrefix
  ? await client.query(
      `select id, title, url, body_text, genre, status, deadline_at, audience
         from notices where id like $1 || '%' limit 1`,
      [idPrefix],
    )
  : await client.query(
      `select id, title, url, body_text, genre, status, deadline_at, audience
         from notices
        where audience = 'public' and status = 'open'
        order by deadline_at nulls last, id`,
    );

if (candidates.rows.length === 0) {
  console.error('没有符合条件的条目（公众广域且库内 open 为空？）');
  await client.end();
  process.exit(1);
}

/**
 * 「还没截止」必须用**展示口径**判一次，不能信库内那一列。
 *
 * 这一列是抓取时推导的，而抓取每日一轮 ⇒ 刚过截止的条目在库里仍是 `open`，
 * 能挂十几个小时（`notice-status.ts` 头注里有生产实测）。第一次跑这个探针就踩到了：
 * 按 `status='open'` 取前三条，取到的是**昨天刚截止**的三部法律草案（0 份可读附件、
 * 因而一条都没跑到），而计划里说的"3 条公众广域"一条都没进候选。
 * 判据复用 `effectiveStatus()`（页面徽标、`?open=1`、RSS 用的是同一份），不在这里另写一遍。
 */
const targets = idPrefix
  ? candidates
  : {
      rows: candidates.rows.filter(
        (row) =>
          effectiveStatus({ status: row.status, deadlineAt: row.deadline_at }, new Date()) === 'open',
      ),
    };
if (!idPrefix) {
  console.log(
    `候选：库内 open 的公众广域 ${candidates.rows.length} 条 ⇒ 按展示口径真的还没截止的 ${targets.rows.length} 条` +
      `（差 ${candidates.rows.length - targets.rows.length} 条是"到期了但还没被下一轮抓取改口"的）\n`,
  );
}

/** 与生产同一份适配器：提示词、归一化、诊断全走它，探针不另写一份。 */
const llm = createLlmPort();
console.log(`模型端口 ${llm.provider} / ${llmModelName(llm)}；最多跑 ${limit} 条\n`);

let unusable = 0;
let ran = 0;
for (const row of targets.rows) {
  if (ran >= limit) break;
  const attachments = await client.query(
    `select url, name, status, char_count, extracted_text
       from notice_attachments where notice_id = $1 order by char_count desc nulls last`,
    [row.id],
  );

  console.log(`${'='.repeat(96)}`);
  console.log(`条目 ${row.id}  受众面 ${row.audience}  体裁 ${row.genre}  截止 ${row.deadline_at}`);
  console.log(`    ${row.title}`);

  const target = {
    id: row.id,
    title: row.title,
    url: row.url,
    bodyText: row.body_text,
    sourceId: '',
    genre: row.genre,
    audience: row.audience,
  };
  // 与生产同一份喂入判据（档位、预算、结构感知截取、角色判定、喂入清单）
  const { tier, sources, report } = await feedPlanForSummary(target);
  console.log(
    `\n[喂入] ${tier === 'deep' ? '重档' : '标准档'}：${report.sources.length} 份 / ${report.usedCjk} 汉字` +
      `（预算 ${report.budget.total}，单份上限 ${report.budget.perSource}，保底 ${report.budget.minShare}）`,
  );
  for (const item of report.sources) {
    console.log(
      `   [${String(item.role).padEnd(11)}] 送入 ${String(item.chars).padStart(6)} 字符 / ${String(item.fedCjk).padStart(5)} 汉字` +
        `（原件 ${item.fullCjk} 汉字${item.truncated ? '，被截' : '，整份'}） ${item.name}`,
    );
  }
  for (const item of report.starved) {
    console.log(`   ⚠ 一个字都没喂进去：${item.name}（${item.fullCjk} 汉字）`);
  }

  if (sources.length === 0) {
    const readable = attachments.rows.filter(
      (item) => item.status === 'ok' && (item.char_count ?? 0) >= 400,
    ).length;
    console.log(
      `   ⇒ 没喂任何条文（附件 ${attachments.rows.length} 份，其中可读 ${readable} 份）` +
        '，这条按设计不产出条文要点/改动点，**不计入这一轮**',
    );
    unusable += 1;
    continue;
  }
  ran += 1;

  const input = {
    title: row.title,
    bodyText: row.body_text ?? '',
    url: row.url,
    draftSources: sources,
    tier,
  };

  let result;
  const startedAt = Date.now();
  try {
    result = await llm.summarize(input);
  } catch (error) {
    // 失败也是结论：它说明这条通道在这个输入规模下会怎样失败（而失败会转人工复核）
    console.log(`\n[调用失败] ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  // 与 worker 落库前同一份逐字反查（这里只是"会落库什么"，不写库）
  const allTexts = attachments.rows.map((item) => item.extracted_text ?? '').join(' ');
  const changeMarkers = countChangeMarkers(allTexts);
  const explanationSections = sources.some((source) => source.role === 'explanation')
    ? countExplanationSections(
        attachments.rows
          .filter((item) => attachmentRole(item.name) === 'explanation')
          .map((item) => item.extracted_text ?? '')
          .join(' '),
      )
    : null;
  const { summary, tally } = buildQuotedSummaryWithTally(
    result,
    result.quotes,
    sources,
    explanationSections,
    changeMarkers,
  );
  const kept = {
    keyPoints: summary.keyPoints.length,
    explanationPoints: summary.explanationPoints.length,
    channels: summary.channels.length,
    impacts: summary.impacts.length,
    changes: summary.changes.length,
  };
  /**
   * 诊断要与 worker **同一份合成方式**（`buildSummaryDiagnostics`）。
   *
   * 第一版这里直接打了适配器上报的那一份，于是它把 `说明要点 3/3` 打了出来 ——
   * 而真正落库的是 **0** 条（三条引用都没过逐字反查）。适配器那一份的 `kept` 是**占位**
   * （它看不到反查），只有 worker 会用真数覆盖它。照抄 worker 的合成，量具才不会说谎。
   */
  const diagnostics = buildSummaryDiagnostics(result.diagnostics, {
    model: llmModelName(llm),
    provider: llm.provider,
    attempts: 1,
    kept,
    quoteNotFound: tally.quoteNotFound,
    feed: report,
  });

  // 读者会看到什么（下面这块就是详情页那两节的文字版）
  console.log(`\n[产出] ${elapsed}s  条文要点 ${summary.keyPoints.length} / 说明要点 ${summary.explanationPoints.length} / 判读 ${summary.impacts.length} / 改动 ${summary.changes.length}（反查丢掉 ${tally.quoteNotFound} 条）`);
  console.log(`[诊断] ${describeDiagnostics(diagnostics)}`);

  if (summary.impacts.length > 0) {
    console.log('\n  ── 可能的争议点（本站 AI 推断，非官方表述） ──');
    for (const item of summary.impacts) {
      console.log(`   • [${item.kind}] ${item.who || '（未写明影响谁）'}：${item.text}`);
      console.log(`     引用：${item.quote}`);
      console.log(`     ${draftProvenanceLine(item.source, '出处：（未反查到出处 —— 不该落库）')}`);
    }
  } else {
    console.log('\n  ── 可能的争议点：本页不渲染（一条都没过逐字反查） ──');
  }

  if (summary.changes.length > 0) {
    const verdict = changeCoverageVerdict(summary.changes.length, changeMarkers);
    console.log(`\n  ── 改了哪几处（覆盖度：${verdict.state}） ──`);
    console.log(`     ${verdict.detail}`);
    for (const item of summary.changes) {
      console.log(`   • ${item.clause || '—'} ｜ ${item.kind} ｜ ${item.text}`);
      console.log(`     原文：${item.quote}`);
      console.log(`     ${draftProvenanceLine(item.source, '出处：（未反查到出处 —— 不该落库）')}`);
    }
  } else {
    console.log('\n  ── 改了哪几处：本页不渲染（一行都没反查到） ──');
    console.log(`     全文里检测到的改动表述：${changeMarkers.total} 处 ${JSON.stringify(changeMarkers.byKind)}`);
  }

  if (showDrops) {
    // 落库那一份之外的**全部**改动行（`result.changes` 是适配器归一化后的原样产出，
    // 还没有过反查这一关）—— 逐段指出它死在哪一段。
    const emitted = Array.isArray(result.changes) ? result.changes : [];
    const keptQuotes = new Set(summary.changes.map((item) => item.quote));
    const dropped = emitted.filter((row) => typeof row?.quote === 'string' && !keptQuotes.has(row.quote));
    console.log(`\n  ── 改动行为什么被丢（模型吐了 ${emitted.length} 行，落库 ${summary.changes.length} 行） ──`);
    if (dropped.length === 0) {
      console.log('     （这一遍没有被丢掉的改动行）');
    }
    for (const row of dropped) {
      console.log(`   ✗ ${row.clause || '—'} ｜ ${row.kind || '?'} ｜ ${row.text || ''}`);
      const segments = quoteSegments(row.quote);
      for (const [index, segment] of segments.entries()) {
        const hit = findDraftSourceForQuote(segment, sources);
        const why =
          segment.length < MIN_VERIFIABLE_QUOTE_CHARS
            ? `不到 ${MIN_VERIFIABLE_QUOTE_CHARS} 字门槛（${segment.length} 字）`
            : hit
              ? `这一段能查到（${hit.name}）`
              : '这一段在任何一份来源里都查不到';
        console.log(`       第 ${index + 1} 段｜${why}：${segment}`);
      }
      if (segments.length === 0) console.log('       引用整条是空的');
    }
  }

  if (summary.explanationPoints.length > 0) {
    console.log(`\n  ── 编制说明要点 ${summary.explanationPoints.length} 条 ──`);
    for (const item of summary.explanationPoints) console.log(`   • ${item.heading}：${item.text}`);
  }

  if (showRaw && diagnostics?.raw) {
    console.log(`\n[模型原始输出 ${diagnostics.rawChars} 字${diagnostics.rawTruncated ? '（已截断）' : ''}]`);
    console.log(diagnostics.raw.slice(0, 4_000));
  }
  console.log('');
}

await client.end();
console.log(
  `共跑 ${ran} 条（另有 ${unusable} 条没喂进条文、未调用模型，不计入）。`,
);
console.log('这一轮的产物**没有写进库**：它只回答"如果现在部署，读者会看到什么"。');
