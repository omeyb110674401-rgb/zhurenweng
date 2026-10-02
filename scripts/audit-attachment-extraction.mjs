/**
 * 只读审计：附件抽取的**产出质量**，按源分别出数（issue #57 的验收门）。
 *
 * 为什么要按源分开：附件主机之间的差别就是这个功能的全部难度 —— miit 对任何请求头与出口
 * IP 都回 403，caac 的「意见征求表」是 2.2MB 的空白表，mee 的标准文本是几十 MB 的 PDF。
 * 全站平均会把「六个源全好、四个源全坏」和「十个源都一般」显示成同一个数字，
 * 而这两种结论的下一步动作完全相反。
 *
 * 为什么 #56 的 `who` 指标也在这里：附件读取要解决的正是「影响谁答不出来」。
 * 只看抽取侧的成功率会漏掉真正的问题 —— 抽到了字但摘要仍然答不出 who，
 * 说明缺的是提示词与截取位置，不是文件。当年并排量的 `whoCopied`（「影响谁」逐字抄了
 * 「谁能提」的比例，基线 35 条里 23 条）已随 `whoCanSubmit` 字段一起删除，理由见下面那一处。
 *
 * 用法（生产环境，脚本必须在 /app 下，否则 `pg` 解析不到）：
 *   docker compose run --rm worker node scripts/audit-attachment-extraction.mjs
 * 一轮墙钟与「同主机请求间隔」不在库里，看 worker 日志里那行「附件抽取（模式）本轮：…」。
 */
import { Client } from 'pg';
import { MAX_FILES_PER_NOTICE } from '../src/lib/attachment-select.ts';

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const notices = await client.query(
  `select id, source_id, title, body_text, ai_summary_json, summary_status, attachments_json
     from notices
     where status <> 'closed'`,
);
const rows = await client.query(
  `select notice_id, url, name, status, kind, bytes, char_count, fed_to_summary, last_fetch_at, error
     from notice_attachments`,
);
await client.end();

const byNotice = new Map();
for (const row of rows.rows) {
  if (!byNotice.has(row.notice_id)) byNotice.set(row.notice_id, []);
  byNotice.get(row.notice_id).push(row);
}

/** 抽取状态里哪些算「本轮已经给出结论」；pending 单列 —— 它有两种含义，见下面的分列。 */
const TERMINAL_FAILURES = new Set([
  'blocked',
  'not_a_file',
  'too_large',
  'no_draft_text',
  'scanned_no_text',
  'unsupported_container',
  'error',
  'gone',
]);

const text = (value) => {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
};
const cjkOf = (value) => (text(value).match(/[㐀-䶿一-鿿]/g) ?? []).length;

/** 清单列是 JSON-in-TEXT；解析失败按 0 处理，与仓库层同一口径。 */
const attachmentCountOf = (raw) => {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
};

/** 摘要里「影响谁」那一段的文字（段落是 `{text}` 对象；更旧的形状是裸字符串）。 */
const whoOf = (summaryJson) => {
  try {
    const parsed = typeof summaryJson === 'string' ? JSON.parse(summaryJson) : summaryJson;
    const segment = parsed?.who;
    return typeof segment === 'string' ? segment : text(segment?.text);
  } catch {
    return '';
  }
};

const stats = new Map();
for (const notice of notices.rows) {
  const source = notice.source_id;
  if (!stats.has(source)) {
    stats.set(source, {
      notices: 0,
      withAttachments: 0,
      bodyChars: 0,
      okRows: 0,
      okUsable: 0,
      okChars: 0,
      fedRows: 0,
      pending: 0,
      unselected: 0,
      failures: new Map(),
      statuses: new Map(),
      whoAnswered: 0,
      summarized: 0,
      hostTried: new Map(),
    });
  }
  const s = stats.get(source);
  s.notices += 1;
  s.bodyChars += cjkOf(notice.body_text);
  if (attachmentCountOf(notice.attachments_json) > 0) s.withAttachments += 1;

  const attached = byNotice.get(notice.id) ?? [];
  // 「pending」有两种含义，而且下一步动作相反：没轮到的等下一轮就行，超出每条公示
  // 3 个名额的**永远等不到**（打分是稳定的，同一批附件每轮选出同样三个）。
  // 2026-09-22 线上核对：mee 那 15 行全属后者，它们挂在一人 5～11 个附件的标准文本公示上。
  const decided = attached.filter((row) => row.status !== 'pending').length;
  for (const row of attached) {
    s.statuses.set(row.status, (s.statuses.get(row.status) ?? 0) + 1);
    if (row.status === 'pending') {
      if (decided >= MAX_FILES_PER_NOTICE) s.unselected += 1;
      else s.pending += 1;
      continue;
    }
    if (row.status === 'ok') {
      s.okRows += 1;
      s.okChars += row.char_count ?? 0;
      if ((row.char_count ?? 0) >= 3000) s.okUsable += 1;
      if (row.fed_to_summary) s.fedRows += 1;
    } else if (TERMINAL_FAILURES.has(row.status)) {
      s.failures.set(row.status, (s.failures.get(row.status) ?? 0) + 1);
    }
    const host = (() => {
      try {
        return new URL(row.url).hostname;
      } catch {
        return '（URL 解析失败）';
      }
    })();
    const seen = s.hostTried.get(host) ?? { tried: 0, blocked: 0 };
    s.hostTried.set(host, {
      tried: seen.tried + (row.last_fetch_at === null ? 0 : 1),
      blocked: seen.blocked + (row.status === 'blocked' ? 1 : 0),
    });
  }

  if (notice.summary_status === 'done' || notice.ai_summary_json) {
    s.summarized += 1;
    const who = whoOf(notice.ai_summary_json);
    // 这里原本还有一个 `whoCopied` 指标，量的是「L1 的 who 是不是逐字抄了 whoCanSubmit」。
    // 2026-10-02 删掉 whoCanSubmit 字段后它跟着删了：新摘要不再有这个键，这个指标只能在
    // 旧行上算 —— 而它当年量出来的结论已经落到产品决定里（「影响谁」收窄到行业专业档，
    // 见 docs/pending-issues/88-detail-page-layout.md）。
    if (who.trim() !== '') s.whoAnswered += 1;
  }
}

const num = (value, width) => String(value).padStart(width);

console.log('# 附件抽取产出质量（issue #57），按源分别出数\n');
console.log(
  [
    '源',
    '未截止',
    '带附件',
    '正文均字数',
    'ok',
    'ok且≥3k',
    'ok均汉字',
    '失败面',
    '未入选/待轮',
    '已喂摘要',
    'who非空',
  ]
    .map((head, index) => (index === 0 ? head : head.padStart(9)))
    .join(' | '),
);

for (const [source, s] of [...stats].sort((a, b) => b[1].withAttachments - a[1].withAttachments)) {
  const failures = [...s.failures].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(
    [
      source.padEnd(12),
      num(s.notices, 7),
      num(s.withAttachments, 9),
      num(s.withAttachments === 0 ? '—' : Math.round(s.bodyChars / s.notices), 9),
      num(s.okRows, 9),
      num(s.okUsable, 9),
      num(s.okRows === 0 ? '—' : Math.round(s.okChars / s.okRows), 9),
      (failures === '' ? '—' : failures).padStart(18).slice(0, 24),
      `${s.unselected}/${s.pending}`.padStart(9),
      num(s.fedRows, 11),
      `${s.whoAnswered}/${s.summarized}`.padStart(9),
    ].join(' | '),
  );
}

console.log('\n## 「已抽取但一行字都没有」的明细（这类行会静默把摘要打回公告壳）');
const empty = rows.rows.filter((row) => row.status === 'ok' && (row.char_count ?? 0) < 400);
if (empty.length === 0) console.log('  （无）');
for (const row of empty.slice(0, 15)) {
  console.log(`  ${row.status} 汉字=${row.char_count} ${text(row.name).slice(0, 40)}  ${row.url.slice(0, 80)}`);
}

console.log('\n## 主机维度（每主机试过几次 / 其中 blocked 几次）');
for (const [source, s] of stats) {
  const hosts = [...s.hostTried].filter(([, v]) => v.tried > 0 || v.blocked > 0);
  if (hosts.length === 0) continue;
  const text2 = hosts
    .sort((a, b) => b[1].tried - a[1].tried)
    .slice(0, 6)
    .map(([host, v]) => `${host} 试${v.tried}/拒${v.blocked}`)
    .join('，');
  console.log(`  ${source.padEnd(12)} ${text2}`);
}

console.log('\n## unsupported_container 明细（判型只看文件头；这里要核实是不是我们把类型认窄了）');
const unsupported = rows.rows.filter((row) => row.status === 'unsupported_container');
if (unsupported.length === 0) console.log('  （无）');
for (const row of unsupported.slice(0, 20)) {
  console.log(`  ${text(row.name).slice(0, 40).padEnd(42)} ${text(row.error).slice(0, 52)}`);
}

console.log('\n## 空白表是否被 no_draft_text 正确挡掉（抽查最多 8 行）');
const blank = rows.rows.filter((row) => row.status === 'no_draft_text');
if (blank.length === 0) console.log('  （没有 no_draft_text 行 —— 要么还没轮到，要么阈值没起作用）');
for (const row of blank.slice(0, 8)) {
  console.log(`  汉字=${num(row.char_count, 4)} ${text(row.name).slice(0, 46)}`);
}
