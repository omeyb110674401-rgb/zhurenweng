/**
 * 点名补摘要（2026-09-30）：给**指定的**条目现在就跑一次完整摘要 —— 包括已经截止的那些。
 *
 * ## 为什么需要它
 *
 * 2026-09-30 在生产上量到：公众广域 39 条里有 **31 条已截止、从来没有摘要**，其中 29 条是
 * 公告壳（0 份可读附件、正文 260–687 字）—— 补了也没内容（那是**数据**，不是工具的拒绝理由）；
 * 但**有 2 条例外**，草案全文就写在公告正文里（这类源不发附件，见 `bodyLooksLikeDraft`）：
 *
 * - `0b00deff17dfa050`《中华人民共和国反网络暴力法（征求意见稿）》正文 10,896 字、78 处「第X条」
 * - `71738d1c45736276`《小型个人信息处理者个人信息保护简化措施规定》正文 3,550 字、22 处条号
 *
 * 这两条正是用户要的场景（"事后曝光才有人参与"）：公示期过了，读者才需要读懂它。
 *
 * ## 它绕开的是哪两道门（都不是 bug，都是有意的）
 *
 * 1. **摘要队列的入队条件**：`ai_summary_json IS NULL AND summary_status='pending' AND
 *    status <> 'closed'`，按 `fetched_at, id` 升序取前 50（`listNoticesForSummary`）。
 *    已截止的条目**永远排不到**（#4 的设计：不给"再也提不了意见"的条目花钱）。
 * 2. **`scripts/reset-summaries-for-redraft.mjs` 明确拒绝已截止条目**。它拒绝的理由是
 *    "清空等于永久失去摘要" —— 那条硬红线针对的是**已经有摘要**的条目；而这两条本来就没有
 *    摘要可失去，`--replace` 那条路对它们是空操作。
 *
 * ⇒ 所以这是一个**点名的、经过评审的窄工具**，而不是放宽日常队列口径。改口径会让 107 条
 * 已截止条目一起开始烧调用。
 *
 * ## 代价（跑之前先认下来）
 *
 * **每一条一次 LLM 调用，走的是生产那台境外通道**（`LLM_PROVIDER` 当前配置；
 * `mimo-v2.5` 实测约 87.6s/次@12,000 汉字），失败还会按 `SUMMARY_MAX_RETRIES` 重试
 * （默认首调 + 3 次）。所以 `--limit` 缺省只有 5，不给就不许一次点超过 5 条 ——
 * 要更多请显式写出来。
 *
 * ## 用法（在部署了本仓库的容器里跑，需要 DATABASE_URL；**cwd 必须是仓库根**）
 *
 *   docker compose run --rm worker node scripts/summarize-now.mjs --ids 0b00deff,71738d1c
 *       # 默认**只读**：逐条打印标题 / status / deadline_at / 受众面 / 档位 / 会喂进去几份多少字 /
 *       # 是否已有摘要 / 是否已截止，一个字都不写库
 *   docker compose run --rm worker node scripts/summarize-now.mjs --ids 0b00deff --apply 2>&1 | tee /root/summarize-now.log
 *       # --apply 才写库。**带 tee**：已经截止的条目多半已有摘要或已被人工看过，
 *       # `--replace` 打出的 #BACKUP 行是旧值唯一的备份（compose run --rm 会删掉容器内写的文件）
 *   docker compose run --rm worker node scripts/summarize-now.mjs --ids 71738d1c --apply --replace
 *       # 覆盖已经有的摘要必须显式 --replace，覆盖前把旧值打到 stdout
 *
 * id 可写**唯一前缀**（不唯一/不认识都当场报错退出，一个字节都不改）。
 *
 * ## 两件它**不做**的事
 *
 * - **不发失败告警**：告警的去重键是「本地日历日 × 任务名 × 源」，工具顶着
 *   `summarize-notices` 这个名字发信会把当天这个源真正的那封挤掉（详见
 *   `summarizeOneNotice` 的 `onRetriesExhausted` 注释）。失败照实打在 stdout 上，退出码非 0。
 * - **不改队列口径、不碰 `notices` 之外的任何列**：库里的写入全部由共用的
 *   `summarizeOneNotice` 完成（`ai_summary_json` / `summary_model` /
 *   `summary_diagnostics_json` / `summary_status`，以及"附件已喂"标记），与日常那一轮同一条链。
 */
import { inArray } from 'drizzle-orm';
import { getDb } from '../src/db/client.ts';
import { notices } from '../src/db/schema/sqlite.ts';
import { getNoticeById } from '../src/db/repo/notices.ts';
import {
  MAX_RETRIES,
  feedPlanForSummary,
  summarizeOneNotice,
} from '../worker/jobs/summarize-notices.ts';
import { llmModelName } from '../src/lib/summary-content.ts';
import { createLlmPort } from '../src/lib/ports.ts';
import { llmReady, llmUnavailableReason } from '../src/lib/llm-availability.ts';
import { effectiveStatus, noticeStatusLabel } from '../src/lib/notice-status.ts';
import { SUMMARY_NOT_SUMMARIZED_STATUS } from '../src/lib/summary-display.ts';

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};

const apply = argv.includes('--apply');
const replace = argv.includes('--replace');

/**
 * `--ids`：点名名单。**前缀必须唯一** —— 匹配到 0 条或多条都当场报错退出，
 * 不做"猜一个"（与 `reset-summaries-for-redraft.mjs` 的 `--ids` 同一规矩）。
 */
const idArgs = (flagValue('--ids') ?? '')
  .split(',')
  .map((item) => item.trim())
  .filter((item) => item !== '');
if (idArgs.length === 0) {
  console.error('必须点名：--ids a,b,c（可写唯一前缀）。不带参数跑一次本文件头部的用法与代价那两节。');
  process.exit(1);
}

/**
 * `--limit`（缺省 5）：**不给就不许一次跑超过这个数**。这不是防呆，是那条境外通道的
 * 报价单 —— 每条一次调用、失败按 `SUMMARY_MAX_RETRIES` 还会重试（缺省共 4 次尝试），
 * 点 30 条与点 3 条是完全不同的两件事。写了 `--limit` 却没跟值 ⇒ 值是 `undefined`，
 * 走到下面那条报错上（不静默回落到缺省 5）。
 */
const limitGiven = argv.indexOf('--limit') >= 0;
const limitArg = flagValue('--limit');
const limit = limitGiven ? Number(limitArg) : 5;
if (!Number.isInteger(limit) || limit < 1) {
  console.error(`--limit 要是 >= 1 的整数（给的是 "${limitArg}"）`);
  process.exit(1);
}
if (idArgs.length > limit) {
  console.error(
    `点名 ${idArgs.length} 条超过本次上限 ${limit}（不给 --limit 时缺省 5）：拆成几批跑，` +
      `或显式写 --limit ${idArgs.length} 把这一次的调用代价认下来`,
  );
  process.exit(1);
}

const db = await getDb();

/**
 * 前缀解析**在应用层做**（库内只有几百行，一次取全量 id+title 足够）：与
 * `reset-summaries-for-redraft.mjs` 同一手法 —— 用 `LIKE '前缀%'` 就要处理 `%` / `_`
 * 的转义，而这个工具根本不需要那点性能。
 */
const allRows = await db.select({ id: notices.id, title: notices.title }).from(notices);
const problems = [];
const picked = [];
for (const prefix of idArgs) {
  const hits = allRows.filter((row) => row.id.startsWith(prefix));
  if (hits.length === 0) {
    problems.push(`--ids ${prefix}：库里没有以它开头的条目`);
    continue;
  }
  if (hits.length > 1) {
    const shown = hits
      .slice(0, 5)
      .map((row) => `${row.id.slice(0, 12)}《${row.title.slice(0, 24)}》`)
      .join('、');
    problems.push(
      `--ids ${prefix}：匹配到 ${hits.length} 条，前缀不唯一（写长一点）：${shown}${hits.length > 5 ? ' …' : ''}`,
    );
    continue;
  }
  picked.push(hits[0].id);
}
if (picked.length !== new Set(picked).size) {
  problems.push(`--ids 里同一条被点名了两次（${picked.join(', ')}）：那会白花一次调用`);
}
if (problems.length > 0) {
  for (const problem of problems) console.error(`✖ ${problem}`);
  console.error('点名的条目有问题，中止（一个字节都没改）');
  process.exit(1);
}

/** 摘要四列的**原始值**（不做 `safeParseJson`）：判"已有摘要"要的是 `IS NOT NULL` 这个事实。 */
const rawRows = await db
  .select({
    id: notices.id,
    summaryJson: notices.aiSummaryJson,
    summaryStatus: notices.summaryStatus,
    summaryModel: notices.summaryModel,
    diagnosticsJson: notices.summaryDiagnosticsJson,
  })
  .from(notices)
  .where(inArray(notices.id, picked));
const rawById = new Map(rawRows.map((row) => [row.id, row]));

const now = new Date();
const ROLE_LABELS = { draft: '条文', explanation: '说明', other: '其它' };
/** 逐条事实（只读模式与 --apply 打的是同一份）——判据全部来自库或共用实现，不在这里重算。 */
const entries = [];
for (const id of picked) {
  const record = await getNoticeById(id);
  const raw = rawById.get(id);
  if (record === null || raw === undefined) {
    // 刚刚还在 allRows 里，两处查询取不到只可能是并发被删：照实报，不当成"没有条目"
    console.error(`✖ ${id}：上一句查询还在、这一句取不到了（并发删除？）`);
    process.exit(1);
  }
  const target = {
    id: record.id,
    title: record.title,
    url: record.url,
    bodyText: record.bodyText,
    sourceId: record.sourceId,
    genre: record.genre,
    audience: record.audience,
  };
  // 与 job 同源：喂入计划、档位、每份多少字都由共用实现算，工具不另写一份
  const plan = await feedPlanForSummary(target);
  entries.push({ record, raw, target, plan });
}

console.log(
  `点名 ${entries.length} 条（--limit ${limit}，${apply ? '--apply：会写库' : '只读（未加 --apply）'}${replace ? '，--replace：允许覆盖已有摘要' : ''}）`,
);
console.log('');

for (const entry of entries) {
  const { record, raw, plan } = entry;
  // 两道"状态"分开印（#86 的教训：探针不许只信库内 status 列）——库列决定**队列**收不收，
  // 展示口径决定**读者**看到的徽标，两者在"刚过截止、还没被下一轮抓取改口"的十几个小时里不一致
  const display = effectiveStatus(record, now);
  const closedInDb = record.status === SUMMARY_NOT_SUMMARIZED_STATUS;
  console.log(`▶ ${record.id}  《${record.title}》`);
  console.log(
    `    状态：库内 status=${record.status}（${noticeStatusLabel(record.status)}）｜展示口径=${display}（${noticeStatusLabel(display)}）｜deadline_at=${record.deadlineAt ?? '—'}`,
  );
  console.log(
    `    已截止：${closedInDb ? '是（队列永远不放行 —— 这正是本工具存在的理由）' : '否'}${
      !closedInDb && display === 'closed' ? '；但展示口径已过截止（抓取还没改口，下一轮队列就会把它排除）' : ''
    }`,
  );
  console.log(
    `    受众面：${record.audience ?? '（空 = 本列上线前的存量）'}｜依据：${record.audienceBasis ?? '—'}`,
  );
  if (plan.sources.length === 0) {
    console.log(
      '    喂入：0 份 —— 没有可喂进提示词的条文（没有可读附件 / 正文自带的条文不足门槛）。补它只会得到一份公告壳摘要。',
    );
  } else {
    console.log(
      `    喂入：${plan.report.sources.length} 份 / ${plan.report.usedCjk} 汉字（档位 ${plan.tier}：单份 ≤ ${plan.report.budget.perSource} 字符、合计 ≤ ${plan.report.budget.total} 汉字、保底 ${plan.report.budget.minShare}）`,
    );
    for (const item of plan.report.sources) {
      console.log(
        `      · ${ROLE_LABELS[item.role] ?? item.role}｜${item.origin === 'body' ? '公告正文' : '附件'}｜${item.chars} 字符｜${item.name}${item.truncated ? `（原件 ${item.fullCjk} 汉字，被窗口截过）` : '（整份）'}`,
      );
    }
  }
  if (plan.report.starved.length > 0) {
    console.log(
      `    ⚠ 被预算挤掉 ${plan.report.starved.length} 份：${plan.report.starved
        .map((item) => `${item.name}（${item.fullCjk} 汉字）`)
        .join('、')}`,
    );
  }
  console.log(
    `    已有摘要：${
      raw.summaryJson === null
        ? '无'
        : `有（summary_status=${raw.summaryStatus}，summary_model=${raw.summaryModel ?? '—'}）—— 覆盖必须显式 --replace`
    }`,
  );
  console.log('');
}

/**
 * "已有摘要默认拒绝"是**整批**的硬门（与 `reset-summaries-for-redraft.mjs` 一样先收齐问题再中止）：
 * 混着点 5 条时静默跳过其中 2 条，比直接拒绝更坏 —— 操作者会以为那 2 条也补上了。
 * 只读模式同样按这个判据给结论：它回答的正是"按现在这些参数跑，会不会被挡"。
 */
const wouldOverwrite = entries.filter((entry) => entry.raw.summaryJson !== null);
if (wouldOverwrite.length > 0 && !replace) {
  for (const entry of wouldOverwrite) {
    console.error(`✖ ${entry.record.id}：已经有摘要（要覆盖请显式 --replace）`);
  }
  console.error('中立的做法是先看一眼旧摘要：本工具不替你决定它值不值得覆盖。中止（一个字节都没改）');
  process.exit(1);
}

if (!apply) {
  console.log(
    `只读模式（未加 --apply）：一个字都没改。${
      replace ? '真跑时会先给已有摘要的那几条打 #BACKUP 行再覆盖。' : ''
    }`,
  );
  console.log(
    `要真跑：加 --apply。代价是**每条一次 LLM 调用**，失败最多重试 ${MAX_RETRIES} 次（共 ${MAX_RETRIES + 1} 次尝试，SUMMARY_MAX_RETRIES）。`,
  );
  process.exit(0);
}

// LLM 端口不可用时当场拒绝（job 是"整轮跳过"，工具是"你要做的事做不到"—— 两种都说清原因，
// 原因取同一份 `llmUnavailableReason()`，不另写判据）
if (!llmReady()) {
  console.error(`✖ LLM 端口未配置，现在跑不了：${llmUnavailableReason() ?? '原因未知'}`);
  process.exit(1);
}
const llm = createLlmPort();
const model = llmModelName(llm);

let succeeded = 0;
let failedReview = 0;
const broken = [];
for (const entry of entries) {
  const { record, raw, target } = entry;
  if (raw.summaryJson !== null) {
    /**
     * 旧值打 stdout，**不是**顺手写个文件：`docker compose run --rm` 会把容器内写的文件
     * 一起删掉（2026-09-24 在 `reset-summaries-for-redraft.mjs` 上真的踩过：脚本报"已备份"、
     * 宿主机上查不到那个文件）。所以调用方要 `2>&1 | tee`，备份的权威副本是这一行。
     * 三个键连模型名与诊断一起备份：重跑之后最想回头对比的就是"上一次调用到底怎么了"。
     */
    console.log(
      `#BACKUP ${JSON.stringify({
        id: record.id,
        previousSummaryJson: raw.summaryJson,
        previousModel: raw.summaryModel,
        previousDiagnosticsJson: raw.diagnosticsJson,
        backedUpAt: now.toISOString(),
      })}`,
    );
  }
  try {
    const result = await summarizeOneNotice(target, { llm, model, logger: (line) => console.log(line) });
    if (result.outcome === 'done') {
      succeeded += 1;
      console.log(`✔ ${record.id} 已落库（${record.title.slice(0, 30)}）`);
    } else {
      failedReview += 1;
      console.log(`✖ ${record.id} 重试耗尽，已转人工复核：${result.error}`);
    }
  } catch (error) {
    // 共用实现抛出的那类错误（取条文失败、写失败态本身失败、索引之外的意外）：按条记下、
    // 继续跑剩下的 —— 点名的每一条都是有人等着的，不该被前一条的意外带走。
    broken.push({ id: record.id, message: error instanceof Error ? error.message : String(error) });
    console.error(`✖ ${record.id} 处理中断：${broken[broken.length - 1].message}`);
  }
}

console.log('');
console.log(
  `完成：成功 ${succeeded} 条，转人工复核 ${failedReview} 条，中断 ${broken.length} 条（共点名 ${entries.length} 条，model=${model}）`,
);
if (succeeded > 0) {
  console.log(
    '摘要已写进 notices 的摘要四列（ai_summary_json / summary_model / summary_diagnostics_json / summary_status）。',
  );
}
if (failedReview > 0 || broken.length > 0) {
  console.log('有没成的：上面逐条有原因；转人工复核的条目在后台复核队列里（判据 summary_status）。');
  process.exit(1);
}
