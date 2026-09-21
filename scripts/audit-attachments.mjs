/**
 * 只读审计：生产库全部附件的**链接有效性**（issue #35 排查用）。
 *
 * 为什么需要它：附件（草案全文、编制说明、反馈意见表）是「读懂」环节的核心材料，
 * 但快照测试只能证明「链接被解析出来了」，证明不了「点开能下载」——
 * 源站改版、文件被移走、下载接口要会话，都会让附件变成死链，而页面上看不出来。
 *
 * 做法：按 URL 去重（同一条附件常被多条公示引用）→ 逐个请求（先 HEAD，
 * 不支持 HEAD 时退回 Range GET）→ 汇总状态码与内容类型 → 按源分组报告。
 * 礼貌间隔 250ms，UA 用生产爬虫同一个。
 *
 * 用法（生产环境，脚本要挂到 /app 下，否则 pg 解析不到）：
 *   docker compose run --rm -v /tmp/audit-attachments.mjs:/app/scripts/audit-attachments.mjs worker \
 *     node scripts/audit-attachments.mjs
 *
 * 只读：仅 SELECT + 对外 HEAD/GET，不写库。
 */
import { Client } from 'pg';

const UA = 'zhurenweng-crawler/0.1 (+https://cn101.top; gov-notice aggregator)';
const TIMEOUT_MS = 12_000;
const SPACING_MS = 250;

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows } = await client.query(
  `select id, source_id, title, attachments_json from notices
    where attachments_json is not null and attachments_json <> '[]'`,
);
await client.end();

/** URL → 引用它的条目（去重后逐个请求） */
const byUrl = new Map();
let total = 0;
for (const row of rows) {
  let list;
  try {
    list = JSON.parse(row.attachments_json);
  } catch {
    console.log(`附件 JSON 解析失败：${row.id}`);
    continue;
  }
  for (const item of list) {
    total += 1;
    if (!byUrl.has(item.url)) byUrl.set(item.url, { name: item.name, refs: [] });
    byUrl.get(item.url).refs.push({ id: row.id, source: row.source_id, title: row.title });
  }
}

console.log(`附件条目 ${total} 个，去重后 URL ${byUrl.size} 个（来自 ${rows.length} 条公示）\n`);

const results = [];
let index = 0;
for (const [url, meta] of byUrl) {
  index += 1;
  let status = 0;
  let contentType = '';
  let note = '';
  const init = { method: 'HEAD', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) };
  try {
    let response = await fetch(url, init);
    if (response.status === 405 || response.status === 403 || response.status === 501) {
      // 不支持 HEAD 的站点：退回 Range GET（只取前 1KB，避免整包下载）
      response = await fetch(url, {
        method: 'GET',
        headers: { 'user-agent': UA, range: 'bytes=0-1023' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      note = 'HEAD 不支持，用 Range GET';
    }
    status = response.status;
    contentType = response.headers.get('content-type') ?? '';
  } catch (error) {
    status = 0;
    note = error instanceof Error ? error.message : String(error);
  }
  results.push({ url, ...meta, status, contentType, note });
  if (index % 25 === 0) console.log(`  …已检查 ${index}/${byUrl.size}`);
  await new Promise((resolve) => setTimeout(resolve, SPACING_MS));
}

const ok = results.filter((r) => r.status >= 200 && r.status < 300);
const bad = results.filter((r) => !(r.status >= 200 && r.status < 300));

console.log(`\n== 汇总 ==`);
console.log(`  可访问（2xx）：${ok.length}`);
console.log(`  异常：${bad.length}`);

const byStatus = new Map();
for (const item of bad) {
  const key = item.status === 0 ? `网络错误：${item.note.slice(0, 40)}` : `HTTP ${item.status}`;
  if (!byStatus.has(key)) byStatus.set(key, []);
  byStatus.get(key).push(item);
}
for (const [key, items] of [...byStatus.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n  ${key} × ${items.length}`);
  for (const item of items.slice(0, 8)) {
    console.log(`    [${item.refs[0].source}] ${item.name.slice(0, 34)}`);
    console.log(`      ${item.url.slice(0, 110)}`);
    console.log(`      引用条目：${item.refs[0].title.slice(0, 40)}`);
  }
  if (items.length > 8) console.log(`    …还有 ${items.length - 8} 个`);
}

const types = new Map();
for (const item of ok) {
  const key = (item.contentType.split(';')[0] || '(空)').trim();
  types.set(key, (types.get(key) ?? 0) + 1);
}
console.log('\n== 可访问附件的内容类型 ==');
for (const [key, count] of [...types.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)}  ${key}`);
}

/** 按源汇总异常率（定位「哪个源的附件最容易死」） */
const perSource = new Map();
for (const item of results) {
  for (const ref of item.refs) {
    if (!perSource.has(ref.source)) perSource.set(ref.source, { ok: 0, bad: 0 });
    const bucket = perSource.get(ref.source);
    if (item.status >= 200 && item.status < 300) bucket.ok += 1;
    else bucket.bad += 1;
  }
}
console.log('\n== 按源（按引用次数计） ==');
for (const [source, bucket] of [...perSource.entries()].sort()) {
  console.log(`  ${source.padEnd(8)} 可访问 ${String(bucket.ok).padStart(3)} / 异常 ${bucket.bad}`);
}
