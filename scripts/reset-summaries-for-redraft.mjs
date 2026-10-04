/**
 * 存量摘要重跑工具（issue #67）：把「已经有摘要」的条目清空回队列，让它们拿到条文要点。
 *
 * 为什么要工具化而不是一句手打的 UPDATE：入队条件是
 * `ai_summary_json IS NULL AND summary_status='pending' AND status<>'closed'`
 * （`src/db/repo/summaries.ts` 的待摘要查询），所以 `ATTACHMENT_TEXT` 翻成 `on`
 * 之后**存量一条都不会自动重跑** —— 这是有意的（不覆盖已复核过的结果、不每天重烧钱），
 * 但代价是 #57 第 5 步对已有条目不生效。要生效就得显式置换，而置换有两个真实的坑：
 *
 * 1. **清空是单向的**。没先导出旧摘要就重跑，一旦模型失败（或新输出更差），
 *    一条本来能看的摘要就没了。所以本脚本在清空**之前**把旧值写成 JSONL 备份，
 *    备份写不成功就直接退出。
 * 2. **已截止的条目清了等于永久失去摘要**：入队过滤排除了它们（issue #4 的设计），
 *    清空后页面会长期显示「未生成摘要」。所以候选硬性排除 `status='closed'`。
 *
 * 「这条现在重跑到底会不会带上条文」的判据**复用摘要任务自己的**
 * `draftSourcesForSummary()`（同一份门槛、同一份预算、同一个档位判断），
 * 脚本里不另写一遍 —— 另写的后果是脚本说"有条文"、真跑起来却没有。
 *
 * 「这条还缺哪一件、要不要重跑」的判据**不在这里**，在 `src/lib/redraft-candidates.ts`
 * （issue #48）：它过去是脚本里的一行幂等过滤，只判"有没有条文要点"，判不出 L2/L3 的差别，
 * 于是把最该重跑的那一批整批跳过（87 号文档 §9.5 现场读数：38 条被跳过、池子里只剩 9 条
 * 真会被喂进条文）。判据搬进 `.ts` 之后能被单测直读、被 pin 表钉住，而**本脚本只负责
 * 取数与逐条打印理由**。两条硬红线保持不变且更严：已截止（清了永久失去）与
 * 人工复核录入（重跑等于毁掉人的活，`--ids` 也绕不过）。
 *
 * 用法（在部署了本仓库的容器里跑，需要 DATABASE_URL）：
 *   docker compose run --rm worker node scripts/reset-summaries-for-redraft.mjs
 *       # 只读：列出候选与"会被喂进提示词的条文份数/字数"，不动库
 *   docker compose run --rm worker node scripts/reset-summaries-for-redraft.mjs --apply --limit 3
 *       # 金丝雀：先置换 3 条，验完页面再放量
 *   docker compose run --rm -v /var/backups/zhurenweng:/var/backups/zhurenweng \
 *     worker node scripts/reset-summaries-for-redraft.mjs --apply --all 2>&1 | tee /root/redraft.log
 *       # 全量（按条文字数降序，收益大的在前）。**带 -v 或 tee**：
 *       # `run --rm` 会删掉容器内写的文件，stdout 才是不会丢的那份备份
 *   docker compose run --rm -v /var/backups/zhurenweng:/var/backups/zhurenweng \
 *     worker node scripts/reset-summaries-for-redraft.mjs --apply --ids 00f8313e,90311b62 2>&1 | tee /root/redraft.log
 *       # 点名重跑（2026-09-26 加，issue #79）：改的是**体裁模板**而不是缺条文时用它 ——
 *       # 这类条目通常已经带着可核对的条文要点，会被幂等过滤跳过，所以 --ids 明确绕过那层过滤。
 *       # id 可写前 8 位（前缀必须唯一，匹配到多条会当场报错退出）。
 *
 * 清空只把它们放回 pending；真正重跑要等下一轮摘要任务（或重启 worker 立刻跑一轮）。
 *
 * ⚠️ **点名重跑的条目要落在队列前 50 名内**（2026-09-30 实测补记）：队列口径是
 * `ai_summary_json IS NULL AND summary_status='pending' AND status <> 'closed'`，按
 * `fetched_at, id` 升序取前 50（见 `listNoticesForSummary`）。两个坑：① 排除条件是
 * **`'closed'`** 而不是 `'expired'` —— 按后者量会把已截止条目算进队列，得出一个"队列堵了"
 * 的假数（doc 86 §22.4 里我就这样骗过自己一次，还差点去加一个"点名插队"的能力）；
 * ② 每轮抓取会刷新 `fetched_at`，所以一条刚被重抓的老条目会排到队尾。**重跑前先量位置**，
 * 别信"清空了就会跑"。
 *
 * 恢复：`#BACKUP {"id":…,"previousSummaryJson":…}` 每行一条，按 id 写回 `notices.ai_summary_json`
 * 并把 `summary_status` 置回 `done` 即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { inArray, isNotNull } from 'drizzle-orm';
import { getDb } from '../src/db/client.ts';
import { notices } from '../src/db/schema/sqlite.ts';
import { clearSummaryForRedraft } from '../src/db/repo/summaries.ts';
import { draftSourcesForSummary } from '../worker/jobs/summarize-notices.ts';
import { redraftCandidate } from '../src/lib/redraft-candidates.ts';
import { MANUAL_SUMMARY_MODEL } from '../src/lib/summary-content.ts';
import { SUMMARY_NOT_SUMMARIZED_STATUS } from '../src/lib/summary-display.ts';
import { safeParseJson } from '../src/db/types.ts';

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

/**
 * `--ids`（issue #79）：点名重跑，给"体裁模板变了"这种情形用 —— 那时条目往往
 * **已经带着可核对的条文要点**（所以会被下面的幂等过滤跳过），要的却是换一套提示词重写。
 * 接受前 8 位前缀；前缀不唯一就当场报错，不做"猜一个"。
 */
const idsIndex = process.argv.indexOf('--ids');
const idArgs =
  idsIndex >= 0
    ? (process.argv[idsIndex + 1] ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '')
    : [];
if (idsIndex >= 0 && idArgs.length === 0) {
  console.error('--ids 后面要跟逗号分隔的 id（可写前 8 位），例如 --ids 00f8313e,90311b62');
  process.exit(1);
}

const db = await getDb();

// 候选：已有摘要的条目。**哪一条该重跑由 `src/lib/redraft-candidates.ts` 判**
// （issue #48：判据搬进 `.ts` 才能被单测直读、被 pin 表钉住 —— 脚本这一层只负责取数与打印）。
const withSummary = await db
  .select({
    id: notices.id,
    title: notices.title,
    url: notices.url,
    bodyText: notices.bodyText,
    sourceId: notices.sourceId,
    // 受众面（issue #86 第 3 刀）：它决定喂入档位，所以"这条会不会带上条文"的预判
    // 必须与生产用同一份输入 —— 少了这一列，脚本会按标准档预估、生产按重档跑
    audience: notices.audience,
    status: notices.status,
    summaryStatus: notices.summaryStatus,
    // 摘要模型名（issue #48）：`manual` = 人工复核录入，重跑等于毁掉人的活（硬红线之一）
    summaryModel: notices.summaryModel,
    summaryJson: notices.aiSummaryJson,
  })
  .from(notices)
  .where(isNotNull(notices.aiSummaryJson));

/**
 * 逐条判「还缺哪一件」（issue #48）：进 / 不进候选，各带一句人话的理由。
 *
 * 为什么逐条给理由而不是只印一个数：这条清单是**回填的依据**（第 5 条 #51），
 * 而"看不见的缺口"正是本项目定义缺陷的方式 —— 只印"可置换池 41 条"，
 * 读的人没法核对那 41 条是不是真该跑，也无从发现判据把某一批整批漏掉。
 */
const verdicts = withSummary.map((row) => ({
  row,
  ...redraftCandidate({
    status: row.status,
    summaryModel: row.summaryModel,
    summary: safeParseJson(row.summaryJson),
  }),
}));
const pool = verdicts.filter((item) => item.candidate).map((item) => item.row);
const skipped = verdicts.filter((item) => !item.candidate);

console.log(
  `已有摘要 ${withSummary.length} 条：不进候选 ${skipped.length} 条、⇒ 可置换池 ${pool.length} 条`,
);
/**
 * 候选逐条列出（含理由），**并且**把不进候选的也逐条列出（含理由）：
 * 后者看着啰嗦，但它正是这一刀要修的那件事的另一面 —— 旧判据把 38 条整批跳过、
 * 而输出里一个字都没说（读的人只会觉得"池子里本来就没东西"）。
 */
console.log('不进候选的条目（逐条给出为什么）：');
for (const item of skipped) {
  console.log(`  ${item.row.id.slice(0, 8)}  ${item.reason}`);
}
console.log('候选的条目（逐条给出为什么进；真正动手时还要看"能不能喂进条文"）：');
for (const item of verdicts) {
  if (!item.candidate) continue;
  console.log(`  ${item.row.id.slice(0, 8)}  ${item.reason}  ${item.row.title.slice(0, 34)}`);
}

/**
 * 点名名单 → 条目。三种情况都要吵出来而不是静默缩小工作范围：
 * 前缀匹配到 0 条、匹配到多条、以及匹配到的条目**已经截止**（清了就永久失去摘要，
 * 这是本工具唯一的硬红线，`--ids` 也不许绕过）。
 */
let picked;
if (idArgs.length > 0) {
  const matched = [];
  const problems = [];
  for (const prefix of idArgs) {
    const hits = withSummary.filter((row) => row.id.startsWith(prefix));
    if (hits.length === 0) {
      problems.push(`--ids ${prefix}：库里没有以它开头、且已有摘要的条目`);
      continue;
    }
    if (hits.length > 1) {
      problems.push(`--ids ${prefix}：匹配到 ${hits.length} 条，前缀不唯一（写长一点）`);
      continue;
    }
    if (hits[0].status === SUMMARY_NOT_SUMMARIZED_STATUS) {
      problems.push(`--ids ${prefix}：这条已截止，清空等于永久失去摘要 —— 本工具不动它`);
      continue;
    }
    /**
     * 人工复核录入的那一份（issue #48）：`--ids` 从前也绕得过去，而它比"已截止"更该拦 ——
     * 清了不是"永久失去"，是**直接毁掉人的活**（那份摘要是有人读原文写出来的）。
     * 真要覆盖它，正确入口是 `scripts/summarize-now.mjs --replace`（那条路会先打印旧值）。
     */
    if (hits[0].summaryModel === MANUAL_SUMMARY_MODEL) {
      problems.push(
        `--ids ${prefix}：这条摘要是**人工复核录入**的（summary_model=manual），重跑等于毁掉人的活 —— 本工具不动它`,
      );
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
  console.log(
    `点名重跑 ${picked.length} 条（--ids 会绕过"已经有条文要点"那层幂等过滤：` +
      `换的是体裁模板，不是补条文 —— 上面那段池子统计与本次名单无关）`,
  );
  for (const row of picked) {
    const sources = await draftSourcesForSummary(row);
    const chars = sources.reduce((sum, source) => sum + source.text.length, 0);
    console.log(
      `  ${row.id.slice(0, 8)} ${sources.length} 份 / ${chars} 字符  ${row.title.slice(0, 34)}`,
    );
  }
}

// 逐条问摘要任务自己：这条现在重跑会喂进几份、多少字条文
const scored = [];
for (const row of picked ?? pool) {
  const sources = await draftSourcesForSummary(row);
  const chars = sources.reduce((sum, source) => sum + source.text.length, 0);
  if (sources.length > 0) scored.push({ row, files: sources.length, chars });
}
scored.sort((a, b) => b.chars - a.chars);

if (!picked) {
  const noDraft = pool.length - scored.length;
  console.log(
    `会被喂进条文的 ${scored.length} 条；剩下 ${noDraft} 条没有可读条文（附件没抽出来 / 没附件 / ` +
      `正文本身够长）—— 重跑它们只会白花一次调用，不动`,
  );
  for (const item of scored.slice(0, 15)) {
    // 「字符」而不是「字」：提示词预算（每份 8,000 / 合计 12,000 个**汉字**）按汉字数算，
    // 这里打的是字符串长度，两者不是一回事，混着写会让人以为预算被超了
    console.log(
      `  ${item.row.id.slice(0, 8)} 条文 ${item.files} 份 / ${item.chars} 字符  ${item.row.title.slice(0, 30)}`,
    );
  }
  if (scored.length > 15) console.log(`  …另 ${scored.length - 15} 条`);
}

if (!apply) {
  console.log('\n只读模式（未加 --apply）：一个字都没改。');
  process.exit(0);
}

// 点名模式下名单已经定了（且已逐条报过"会喂进几份"），不再按字数排序取前 N
const chosen = picked ?? scored.slice(0, limit).map((item) => item.row);
if (chosen.length === 0) {
  console.log('没有可置换的条目，退出。');
  process.exit(0);
}

const backupDir = process.env.REDRAFT_BACKUP_DIR || '/var/backups/zhurenweng';
const backupFile = path.join(backupDir, `pre-redraft-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

// 备份先取出来，一条都不先清：清空是单向操作
const before = await peekSummaries(chosen.map((row) => row.id));
const lines = before.map((row) =>
  JSON.stringify({
    id: row.id,
    previousSummaryJson: row.previousSummaryJson,
    previousModel: row.previousModel,
    // 诊断也一起备份（issue #86）：清空会把那一列一起抹掉，而"上一次调用到底怎么了"
    // 恰恰是重跑之后最想回头对比的东西（重跑前后的 emitted/kept/丢弃数就在这两份里）
    previousDiagnosticsJson: row.previousDiagnosticsJson,
    // 审读记录也一起备份（issue #47）：它同样是"清空即抹掉"的一列，而且是**可抛弃**的 ——
    // 重跑会产出新的审读结论，旧的只在"想知道上一轮判了什么"时有用，而那正是备份的用处
    previousImpactReviewJson: row.previousImpactReviewJson,
    backedUpAt: new Date().toISOString(),
  }),
);

/**
 * 备份**必须同时打到 stdout**，原因不是冗余而是正确性：
 * `docker compose run --rm` 里写进容器文件系统的东西会随容器一起消失 ——
 * 2026-09-24 第一次跑金丝雀时就踩到了（脚本报"已备份"，宿主机上却查不到那个文件）。
 * `/var/backups/...` 只有在外挂时才持久，所以调用方要么带 `-v`，要么把 stdout 重定向存下来：
 *   docker compose run --rm -v /var/backups/zhurenweng:/var/backups/zhurenweng \
 *     worker node scripts/reset-summaries-for-redraft.mjs --apply --all 2>&1 | tee /root/redraft.log
 * 写文件失败也不再中止：备份的**权威副本是 stdout**，文件只是方便起见。
 */
for (const line of lines) console.log(`#BACKUP ${line}`);
try {
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(backupFile, `${lines.join('\n')}\n`, { flag: 'wx' });
  console.log(`旧摘要另存了一份：${backupFile}（${before.length} 行）`);
} catch (error) {
  console.log(`（未能写文件：${String(error.message)}；以 stdout 的 #BACKUP 行为准）`);
}
console.log(`备份行数 ${before.length} / 待清空 ${chosen.length} —— 对不上就不要继续`);
if (before.length !== chosen.length) {
  console.error('备份条数与名单不符，中止（一个字节都没改）');
  process.exit(1);
}

await clearSummaryForRedraft(chosen.map((row) => row.id));
console.log(
  `已清空并置回 pending：${chosen.length} 条 ⇒ 等下一轮摘要任务（或 docker compose up -d worker 立刻跑一轮）`,
);
for (const row of chosen) console.log(`  ${row.id.slice(0, 8)}  ${row.title.slice(0, 36)}`);

/**
 * 只读不改：按名单取当前摘要值。备份必须在清空**之前**落盘（清空是单向的），
 * 而 `clearSummaryForRedraft` 是"读+清"一体的，所以这里先单独读一次。
 * 两段之间没有别的写入者：摘要任务只写 `ai_summary_json IS NULL` 的行。
 */
async function peekSummaries(ids) {
  const rows = await db
    .select({
      id: notices.id,
      previousSummaryJson: notices.aiSummaryJson,
      previousModel: notices.summaryModel,
      previousDiagnosticsJson: notices.summaryDiagnosticsJson,
      // 同上（issue #47）：审读记录也由 `clearSummaryForRedraft` 一起清掉
      previousImpactReviewJson: notices.impactReviewJson,
    })
    .from(notices)
    .where(inArray(notices.id, ids));
  return rows;
}
