/**
 * 构建期自检：裁过 pdfjs 之后，抽取附件条文的**真实代码路径**在镜像里还是不是好的。
 *
 * 为什么要有这一步：Dockerfile 会在 `npm ci` 之后删掉 pdfjs-dist 里我们用不到的产物
 * （见那里的注释：35MB 里 28MB 是浏览器查看器、现代构建、source map 与图像解码器）。
 * 删错一个文件的表现不是构建失败，而是**生产上每一个 PDF 都落成
 * `unsupported_container`** —— 一个静默的、要跑一轮才看得见的退化。所以把「删完能不能
 * 解析」做成构造期就炸的门。
 *
 * 判据用的是 `scripts/make-attachment-fixtures.mjs` 生成的同一批夹具、以及
 * `src/lib/attachments/parse.ts` 这个**生产入口**本身（不是直接调 pdfjs）—— 于是这一趟
 * 走的是动态 import、判型、cMap/标准字体路径、清洗与扫描件判据的整条链。
 *
 * 用法（构建期，两个镜像都在 /app 下）：
 *   node scripts/make-attachment-fixtures.mjs && node scripts/verify-attachment-parsers.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAttachmentKind } from '../src/lib/file-magic.ts';
import { parseAttachment } from '../src/lib/attachments/parse.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(root, 'fixtures/e2e-attachments');

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : `  ${detail}`}`);
  if (!ok) failures.push(label);
};

/**
 * pdfjs 按 URL 取的两种外部资源：删掉之后解析**照样成功**，只在碰到不带 ToUnicode 的
 * CID 字体（WPS 与老生成器的常见产物）或内嵌字体缺字库时才显形 —— 那种失败在库里长得
 * 和「这是个扫描版」一模一样，事后根本查不到是这里掉的。所以单独断言目录还在且非空。
 */
function assetDir(name) {
  const entry = path.join(root, 'node_modules/pdfjs-dist', name);
  if (!existsSync(entry)) return null;
  return readdirSync(entry);
}

for (const [label, name] of [
  ['cMaps 目录', 'cmaps'],
  ['标准字体目录', 'standard_fonts'],
]) {
  const listing = assetDir(name);
  check(`${label}存在且非空`, listing !== null && listing.length > 0, listing === null ? name : `${listing.length} 项`);
}

async function parseFile(fileName) {
  const body = new Uint8Array(readFileSync(path.join(FIXTURE_DIR, fileName)));
  const kind = detectAttachmentKind(body.subarray(0, 8));
  return { kind, result: await parseAttachment({ kind, body }) };
}

// 1) 文本型 PDF：必须出字，且带上只有解析成功才会有的结构。
//    夹具里这份是手写 PDF 对象、只能带 ASCII（中文文本型 PDF 是另一份外部打印的
//    cjk-text.pdf，构建期不保证有），所以断言取英文锚点。
const pdf = await parseFile('draft.pdf');
check(
  'PDF 解析出条文',
  pdf.result.status === 'ok' && pdf.result.text.includes('Article 2 These measures apply to'),
  `status=${pdf.result.status} 字符=${pdf.result.charCount} 页=${pdf.result.pages ?? '-'}`,
);
check('PDF 判型为 pdf', pdf.kind === 'pdf', pdf.kind);

// 2) 扫描型 PDF：0 字但不是异常，要落在自己的终态上
const scan = await parseFile('scan-only.pdf');
check(
  '扫描版判为 scanned_no_text',
  scan.result.status === 'scanned_no_text',
  `status=${scan.result.status} 字符=${scan.result.charCount}`,
);

// 3) docx：走 fflate + word-extractor 那一路（与 PDF 共用了「裁包」这一步，容易被误删）
const docx = await parseFile('draft.docx');
check(
  'DOCX 解析出条文',
  docx.result.status === 'ok' && docx.result.text.includes('第二条 适用范围'),
  `status=${docx.result.status} 字符=${docx.result.charCount}`,
);

if (failures.length > 0) {
  console.error(`\n镜像内的附件解析是坏的：${failures.join(' / ')}`);
  console.error('要么裁多了（对照 Dockerfile 里那份清单），要么 pdfjs 升级换了运行期动态 import 的文件。');
  process.exitCode = 1;
}
