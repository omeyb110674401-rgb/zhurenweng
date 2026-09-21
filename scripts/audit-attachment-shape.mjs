/**
 * 只读审计：附件条目本身的形状问题（issue #35 排查用）—— 与「链接是否可达」不同，
 * 这里查的是**我们自己产出的数据**是否有问题：
 *
 * 1. 名字质量：没有扩展名、名字就是文件名（W020…docx）、名字过长 / 过短、名字与 URL
 *    扩展名不一致（如名字写 .pdf 而链接是 .doc）；
 * 2. 内容真伪：对可疑内容类型（utf-8 / application/octet-stream / 空）取前 1KB 看
 *    魔数 —— 若返回的是 HTML（<!DOCTYPE / <html），说明我们列出来的「附件」其实是个
 *    网页（错误页 / 登录页 / 预览页），那才是真正属于我们的缺陷；
 * 3. 同一条公示内 URL 重复、以及跨条目的重复引用（供判断是否值得缓存）。
 *
 * 用法（生产环境，挂到 /app 下）：
 *   docker compose run --rm -v /tmp/audit-attachment-shape.mjs:/app/scripts/audit-attachment-shape.mjs \
 *     worker node scripts/audit-attachment-shape.mjs
 */
import { Client } from 'pg';
import { CRAWLER_USER_AGENT } from '../src/lib/site-identity.ts';

const UA = CRAWLER_USER_AGENT;

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows } = await client.query(
  `select id, source_id, title, attachments_json from notices
    where attachments_json is not null and attachments_json <> '[]'`,
);
await client.end();

const items = [];
for (const row of rows) {
  let list;
  try {
    list = JSON.parse(row.attachments_json);
  } catch {
    continue;
  }
  for (const item of list) {
    items.push({ ...item, noticeId: row.id, source: row.source_id, title: row.title });
  }
}

const hasExt = (text) => /\.[a-z0-9]{2,5}$/i.test(text.trim());
const fileNameLike = (name) => /^(W0|t\d{8}|c_\d|[0-9a-f]{16,})\S*$/i.test(name.trim());
const SUSPICIOUS_NAME = /^(下载|附件|文件|查看|点击|document|file|download)$/i;

/**
 * 文件魔数判定（用字符码比较，不用带控制字符的正则 —— 后者会触发
 * ESLint 的 no-control-regex）：PDF / ZIP(docx,xlsx) / OLE(doc,xls) / RAR / GZIP。
 */
function hasFileMagic(head) {
  if (head.startsWith('%PDF') || head.startsWith('PK') || head.startsWith('Rar!')) return true;
  const codes = [0, 1, 2, 3].map((index) => head.charCodeAt(index));
  if (codes[0] === 0xd0 && codes[1] === 0xcf && codes[2] === 0x11 && codes[3] === 0xe0) return true;
  return codes[0] === 0x1f && codes[1] === 0x8b;
}

console.log(`附件条目 ${items.length} 个（来自 ${rows.length} 条公示）\n`);

const noExt = items.filter((item) => !hasExt(item.name));
const fileLike = items.filter((item) => fileNameLike(item.name));
const generic = items.filter((item) => SUSPICIOUS_NAME.test(item.name.trim()));
const tooLong = items.filter((item) => item.name.length > 80);
const mismatch = items.filter((item) => {
  const urlExt = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(new URL(item.url).pathname)?.[1]?.toLowerCase();
  const nameExt = /\.([a-z0-9]{2,5})$/i.exec(item.name.trim())?.[1]?.toLowerCase();
  return urlExt !== undefined && nameExt !== undefined && urlExt !== nameExt;
});

console.log('== 名字质量 ==');
console.log(`  无扩展名：${noExt.length}`);
for (const item of noExt.slice(0, 8)) console.log(`    [${item.source}] 「${item.name.slice(0, 40)}」 ${item.url.slice(0, 70)}`);
console.log(`  名字像文件名（W0…/t2026…/c_…/哈希）：${fileLike.length}`);
for (const item of fileLike.slice(0, 8)) console.log(`    [${item.source}] 「${item.name.slice(0, 40)}」 ${item.url.slice(0, 70)}`);
console.log(`  通用词名字（下载/附件/…）：${generic.length}`);
for (const item of generic) console.log(`    [${item.source}] 「${item.name}」 ${item.url.slice(0, 70)}`);
console.log(`  名字超 80 字：${tooLong.length}`);
for (const item of tooLong.slice(0, 3)) console.log(`    [${item.source}] 「${item.name.slice(0, 90)}…」`);
console.log(`  名字扩展名与 URL 扩展名不一致：${mismatch.length}`);
for (const item of mismatch.slice(0, 8)) {
  console.log(`    [${item.source}] 名字=「${item.name.slice(0, 36)}」 URL=…${item.url.slice(-40)}`);
}

console.log('\n== 同一条公示内 URL 重复 ==');
let dupInNotice = 0;
for (const row of rows) {
  const list = JSON.parse(row.attachments_json);
  const urls = list.map((item) => item.url);
  if (new Set(urls).size !== urls.length) {
    dupInNotice += 1;
    console.log(`    ${row.id} [${row.source_id}] ${list.length} 个附件里有重复 URL：${row.title.slice(0, 34)}`);
  }
}
console.log(dupInNotice === 0 ? '  无' : `  共 ${dupInNotice} 条`);

console.log('\n== 可疑内容类型：取前 1KB 看是不是网页 ==');
const client2 = new Client({ connectionString: process.env.DATABASE_URL });
await client2.connect();
const { rows: noticeRows } = await client2.query(
  `select id, attachments_json from notices where attachments_json is not null and attachments_json <> '[]'`,
);
await client2.end();

const seen = new Set();
let checked = 0;
let htmlLike = 0;
for (const row of noticeRows) {
  for (const item of JSON.parse(row.attachments_json)) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    let head = '';
    let contentType = '';
    try {
      const response = await fetch(item.url, {
        method: 'GET',
        headers: { 'user-agent': UA, range: 'bytes=0-1023' },
        signal: AbortSignal.timeout(12_000),
      });
      contentType = response.headers.get('content-type') ?? '';
      if (!response.ok) continue;
      head = (await response.text()).slice(0, 200);
    } catch {
      continue;
    }
    checked += 1;
    const looksHtml = /<!doctype|<html|<head|<meta/i.test(head);
    const looksFile = hasFileMagic(head);
    if (looksHtml || (!looksFile && contentType.includes('text/html'))) {
      htmlLike += 1;
      console.log(`    可能是网页：type=${contentType}`);
      console.log(`      ${item.url.slice(0, 110)}`);
      console.log(`      开头：${head.replace(/\s+/g, ' ').slice(0, 100)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
console.log(`  已检查 ${checked} 个（2xx 且有响应体），其中像网页的 ${htmlLike} 个`);
