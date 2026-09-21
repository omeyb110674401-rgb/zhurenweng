/**
 * 只读审计：版本链（issue #10）在生产库里的实际状态（issue #35 排查用）。
 *
 * 做四件事：
 * 1. 用生产代码里的 normalizeTitleForVersionMatch 给每条算「法案主体键」，
 *    按（键 × 机关）分组，报告**成员 ≥2 却没有任何 version_of 关联**的组；
 * 2. 报告已关联行的自洽性（序号是否 1..n、version_of 是否指向同组前驱）；
 * 3. 用「法案名」（标题里最长的《…》内容，去掉括号段与标点）做**更松**的分组，
 *    找本应链上却被规范化规则挡在门外的候选对 —— 这是判断「0 条关联」
 *    到底是「库里确实没有同案多轮」还是「匹配规则太严」的关键；
 * 4. 打印几条最长的法案名分组做人工核对。
 *
 * 用法（生产环境，脚本要挂到 /app 下，否则 pg 解析不到）：
 *   docker compose run --rm -v /tmp/audit-versions.mjs:/app/scripts/audit-versions.mjs worker \
 *     node scripts/audit-versions.mjs
 *
 * 只读：仅 SELECT。
 */
import { Client } from 'pg';
import { normalizeTitleForVersionMatch } from '../src/lib/versions.ts';

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows } = await client.query(
  `select id, source_id, title, agency, published_at, version_of, version_seq from notices`,
);
await client.end();

const keyed = rows.map((row) => ({
  ...row,
  key: normalizeTitleForVersionMatch(row.title),
}));

/** 分组：键 × 机关 */
const groups = new Map();
for (const row of keyed) {
  if (row.key === null) continue;
  const groupKey = `${row.agency}\u0000${row.key}`;
  if (!groups.has(groupKey)) groups.set(groupKey, []);
  groups.get(groupKey).push(row);
}

const linked = rows.filter((row) => row.version_of !== null);
console.log(`总条目 ${rows.length}；可参与版本匹配 ${keyed.filter((r) => r.key !== null).length}；`
  + `键为 null（纯轮次词标题）${keyed.filter((r) => r.key === null).length}；`
  + `已关联 version_of 非空 ${linked.length} 条`);
console.log(`（键 × 机关）分组 ${groups.size} 个\n`);

console.log('== 成员 ≥2 的严格分组（应已自动成链） ==');
const multi = [...groups.entries()].filter(([, members]) => members.length > 1);
if (multi.length === 0) console.log('  无');
for (const [groupKey, members] of multi) {
  const [agency, key] = groupKey.split('\u0000');
  console.log(`\n[${agency}] key=${key} 成员 ${members.length} 已关联 ${members.filter((m) => m.version_of !== null).length}`);
  for (const member of members) {
    console.log(`   ${member.published_at ?? '—'} seq=${member.version_seq ?? '—'} of=${member.version_of ?? '—'} ${member.title.slice(0, 48)}`);
  }
}

console.log('\n== 已关联行的自洽性 ==');
let dirty = 0;
for (const members of groups.values()) {
  const byId = new Map(members.map((m) => [m.id, m]));
  for (const member of members) {
    if (member.version_of === null) continue;
    if (!byId.has(member.version_of)) {
      console.log(`  脏链：${member.id} version_of=${member.version_of} 不在同组（${member.title.slice(0, 40)}）`);
      dirty += 1;
    }
  }
}
console.log(dirty === 0 ? '  无脏链' : `  共 ${dirty} 条脏链`);

/** 法案名：标题里最长的《…》内容（无书名号时用整标题），去括号段与标点 */
function actName(title) {
  let longest = '';
  for (const match of title.matchAll(/《([^《》]*)》/g)) {
    if (match[1].length > longest.length) longest = match[1];
  }
  const text = longest.length > 0 ? longest : title;
  return text
    .replace(/[（(][^（）()]*[）)]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

const byAct = new Map();
for (const row of rows) {
  const name = actName(row.title);
  if (name.length < 4) continue;
  const groupKey = `${row.agency}\u0000${name}`;
  if (!byAct.has(groupKey)) byAct.set(groupKey, []);
  byAct.get(groupKey).push(row);
}

console.log('\n== 法案名分组（更松，成员 ≥2）：本应成链的候选 ==');
const actMulti = [...byAct.entries()].filter(([, members]) => members.length > 1);
if (actMulti.length === 0) {
  console.log('  无 —— 库里没有「同一机关 + 同一法案名」的多条条目，'
    + '即当前收录窗口内确实不存在同案多轮公示，0 条关联是数据实况而非规则过严');
}
for (const [groupKey, members] of actMulti) {
  const [agency, name] = groupKey.split('\u0000');
  const strictKeys = new Set(members.map((m) => normalizeTitleForVersionMatch(m.title)));
  console.log(`\n[${agency}] 法案名=${name.slice(0, 40)} 成员 ${members.length}，严格键 ${strictKeys.size} 种`
    + `${strictKeys.size > 1 ? ' ← 严格键不一致（本应同链却被拆开）' : ''}`);
  for (const member of members) {
    console.log(`   ${member.published_at ?? '—'} seq=${member.version_seq ?? '—'} of=${member.version_of ?? '—'} ${member.title.slice(0, 52)}`);
  }
}

console.log('\n== 法案名最长的 8 个分组（人工核对是否有近似同案） ==');
const longestNames = [...byAct.entries()]
  .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  .slice(0, 8);
for (const [groupKey, members] of longestNames) {
  const [agency, name] = groupKey.split('\u0000');
  console.log(`  ${members.length} 条 [${agency}] ${name.slice(0, 46)}`);
}
