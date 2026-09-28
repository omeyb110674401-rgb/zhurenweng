/**
 * 只读探针（issue #86 第十七节）：那份 41 MB 的 npc 草案 PDF **抽不抽得出文字**。
 *
 * 这是"给 npc 法律草案补全文"这条路唯一的未验证环节 —— 若是扫描件，抓下来也没用
 * （`parseAttachment` 会判成扫描件并给出 `no_draft_text`），那 200 MB/轮 的带宽就不该花。
 *
 * 不另写解析逻辑：直接用仓库自己的 `parseAttachment`（容器里那份就是生产用的）。
 * 用法（服务器上，PDF 先下到 /tmp/npc.pdf）：
 *   docker compose run --rm -v /tmp/npc.pdf:/tmp/npc.pdf:ro worker node scripts/probe-npc-pdf.mjs
 */
import fs from 'node:fs';
import { parseAttachment, MAX_STORED_TEXT_CHARS } from '../src/lib/attachments/parse.ts';
import { countArticleAnchors, countCjk } from '../src/lib/attachment-select.ts';

const path = process.argv[2] ?? '/tmp/npc.pdf';
const body = new Uint8Array(fs.readFileSync(path));
console.log(`文件 ${path}：${body.byteLength} 字节（${(body.byteLength / 1024 / 1024).toFixed(1)} MB）`);

const started = Date.now();
const result = await parseAttachment({ kind: 'pdf', body });
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log(`解析 ${seconds}s ⇒ status=${result.status}`);
console.log(`  字符数 ${result.charCount} ｜ 页数 ${result.pages ?? '-'} ｜ 每页字符 ${result.pages ? Math.round(result.text.length / result.pages) : '-'}`);
console.log(`  汉字数 ${countCjk(result.text)} ｜ 「第X条」处数 ${countArticleAnchors(result.text)}`);
console.log(`  正文截断到 ${MAX_STORED_TEXT_CHARS} 字符（超出部分不入库）`);
if (result.error) console.log(`  error: ${result.error}`);
console.log('  开头 300 字：');
console.log(result.text.replace(/\s+/g, ' ').slice(0, 300));
