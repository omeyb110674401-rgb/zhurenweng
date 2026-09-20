/**
 * 结构化速读的数据质量审计（issue #26/#27）：把 `extractChannels` 等抽取函数
 * 跑在**生产库全部条目**上，输出命中率与形态分布。
 *
 * 为什么需要它：单元 / e2e 用的是快照正文，能锁住写法差异，但回答不了
 * 「线上 150 条里到底有多少条能抽出提交方式」——那要靠真实数据。
 * 规则类改动（正则、标签词表）在合并前先跑一遍，前后 diff 就是回归证据。
 *
 * 用法（在部署了本仓库的容器里跑，需要 DATABASE_URL）：
 *   docker compose run --rm worker node scripts/audit-briefs.mjs
 *   docker compose run --rm worker node scripts/audit-briefs.mjs --samples 3
 *
 * 只读：仅 SELECT，不写库。
 */
import { Client } from 'pg';
import { buildNoticeBrief } from '../src/lib/notice-brief.ts';

const samples = Number(process.argv[process.argv.indexOf('--samples') + 1]) || 0;

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows } = await client.query(
  `select n.id, n.source_id, s.name as source_name, n.title, n.body_text, n.status
     from notices n left join sources s on s.id = n.source_id
    order by n.source_id, n.id`,
);
await client.end();

const bySource = new Map();
const kindTotals = { online: 0, email: 0, address: 0, phone: 0, fax: 0 };
const hostCounts = new Map();
let withChannels = 0;
let withBody = 0;
let withLead = 0;
let withItems = 0;
let withDocName = 0;
const examples = [];

for (const row of rows) {
  const source = row.source_name ?? row.source_id ?? '(未知源)';
  const stats = bySource.get(source) ?? {
    total: 0,
    body: 0,
    channels: 0,
    email: 0,
    online: 0,
    address: 0,
    phone: 0,
    fax: 0,
  };
  stats.total += 1;
  if (row.body_text) {
    stats.body += 1;
    withBody += 1;
  }

  const brief = buildNoticeBrief({
    title: row.title,
    bodyText: row.body_text,
    url: 'https://cn101.top/notices/' + row.id,
  });

  if (brief.channels.length > 0) {
    stats.channels += 1;
    withChannels += 1;
  }
  for (const channel of brief.channels) {
    kindTotals[channel.kind] += 1;
    stats[channel.kind] += 1;
    // 在线渠道按 host 汇总：命中率 100% 时最该怀疑的是「把无关链接当成了提交入口」，
    // 一张 host 频次表能立刻看出噪声（例如大量指向某个与提意见无关的站点）。
    if (channel.kind === 'online') {
      const host = new URL(channel.value).host;
      hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
    }
  }
  if (brief.leadParagraph) withLead += 1;
  if (brief.keyItems.length > 0) withItems += 1;
  if (brief.documentNames.length > 0) withDocName += 1;

  bySource.set(source, stats);

  if (samples > 0 && brief.channels.length > 0 && examples.length < samples) {
    examples.push({
      title: row.title.slice(0, 40),
      channels: brief.channels.map((c) => `${c.kind}=${c.value}`),
    });
  }
}

const total = rows.length;
const pct = (n) => `${((n / Math.max(total, 1)) * 100).toFixed(0)}%`;

console.log(`\n=== 结构化速读抽取审计：共 ${total} 条 ===`);
console.log(`有正文            ${withBody}  (${pct(withBody)})`);
console.log(`抽到提交渠道      ${withChannels}  (${pct(withChannels)})`);
console.log(`抽到首段          ${withLead}  (${pct(withLead)})`);
console.log(`抽到分条要点      ${withItems}  (${pct(withItems)})`);
console.log(`抽到文件名称      ${withDocName}  (${pct(withDocName)})`);
console.log(
  `渠道类型分布      在线 ${kindTotals.online} / 邮箱 ${kindTotals.email} / 地址 ${kindTotals.address} / 电话 ${kindTotals.phone} / 传真 ${kindTotals.fax}`,
);

console.log('\n--- 按源 ---');
for (const [source, stats] of [...bySource.entries()].sort()) {
  console.log(
    `${source.padEnd(14)} 共 ${String(stats.total).padStart(3)}  有正文 ${String(stats.body).padStart(3)}  有渠道 ${String(stats.channels).padStart(3)}` +
      `  (在线 ${stats.online} 邮箱 ${stats.email} 地址 ${stats.address} 电话 ${stats.phone} 传真 ${stats.fax})`,
  );
}

console.log('\n--- 在线渠道按域名（频次降序，用于识别噪声） ---');
for (const [host, count] of [...hostCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(count).padStart(3)}  ${host}`);
}

if (examples.length > 0) {
  console.log('\n--- 抽样 ---');
  for (const example of examples) {
    console.log(`· ${example.title}`);
    for (const channel of example.channels) console.log(`    ${channel}`);
  }
}

console.log('\n--- 无渠道条目（应抽查确认原文确实没写） ---');
const missing = rows
  .filter((row) => buildNoticeBrief({ title: row.title, bodyText: row.body_text, url: '' }).channels.length === 0)
  .slice(0, 12);
for (const row of missing) {
  console.log(`· [${row.status}] ${row.title.slice(0, 46)}  正文${row.body_text ? '有' : '无'}`);
}
console.log(`（共 ${total - withChannels} 条无渠道，上面只列前 12 条）`);
