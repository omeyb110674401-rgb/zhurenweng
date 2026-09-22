#!/usr/bin/env node
/**
 * 生成附件解析用的**真实二进制夹具**（issue #57）。
 *
 * 为什么要真文件而不是 mock 字节：解析器的失效方式全是「格式看着对、抽出来是空」——
 * 手写一段假 PDF 头能让 magic 判定通过，却测不出 pdfjs 的取文本路径。拿真文件试跑就是这样
 * 抓到两个 mock 永远抓不到的事实：中文文本 PDF 必须给 pdfjs 配 cMaps 才出得来字，
 * 扫描型 PDF 抽出来是 0 字符而不是报错（所以得有 scanned_no_text 这个独立终态）。
 *
 * 用法：node scripts/make-attachment-fixtures.mjs
 * 产物落在 fixtures/e2e-attachments/ 并随仓库提交；可重复执行（内容确定性，不随时间变）。
 * fixture-server 对未知扩展名按 application/octet-stream 原样吐字节，夹具侧不需要改测试装置。
 *
 * 两个本脚本生成不了的例外，都写在下面 FILES 之外的目录里：
 * - `cjk-text.pdf`：用 Edge `--print-to-pdf` 从一段中文 HTML 打出来的真实文本型 PDF
 *   （自带子集 CID 字体），手写不出来。它钉住「中文条文 PDF 抽得出字」这条主路径；
 *   要换内容得重新打印并提交。
 * - .doc 的**成功**样例：手工合成一个能被 word-extractor 读出中文段落的 OLE 复合文档，
 *   代码量会超过被测试逻辑本身。.doc 约占真实附件两成，成功路径只能靠生产实测覆盖；
 *   这里只覆盖「OLE 头 + 解析抛错 → unsupported_container」这条路（broken.doc）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { strToU8, zipSync } from 'fflate';

const OUT_DIR = path.resolve('fixtures/e2e-attachments');

/** 手写 PDF 只嵌标准 14 字体，所以页面文本用 ASCII（中文见 cjk-text.pdf）。 */
const PDF_PAGES = [
  [
    'Notice on Public Consultation',
    'Article 1 In order to standardize the market',
    'Article 2 These measures apply to enterprises engaged in credit management',
  ],
  ['Drafting Explanation', 'Scope of application: this document applies to all provincial authorities'],
];

const DRAFT_DOCX = [
  '关于公开征求《测试办法（征求意见稿）》的意见',
  '为进一步规范建筑市场秩序，我部起草了《测试办法（征求意见稿）》，现向社会公开征求意见。',
  '第一条 为进一步规范建筑市场信用管理，根据《建筑法》等法律法规，制定本办法。',
  '第二条 适用范围：本办法适用于从事建筑市场信用管理活动的企业、事业单位和社会公众。',
  '第三条 申报单位应当在每年三月三十一日前提交材料。',
  '征求意见期限为30日，截止日期为：2026年10月7日。',
  '一、电子邮箱：test@example.gov.cn',
  '二、通信地址：北京市西城区某路 1 号，邮编 100800',
  '三、联系电话：010-66010000',
  '起草说明：本办法依据《建筑法》等法律制定，共六章三十条。',
];

/**
 * 空白意见表：解析得动，但只有表头与下划线。真实世界里 caac 有一批 2.2MB 的
 * 「意见征求表」附件正是这一类 —— 必须判 no_draft_text，不能进摘要。
 */
const BLANK_FORM_DOCX = [
  '《测试办法（征求意见稿）》意见征求表',
  '姓名：__________　单位：__________　电话：__________',
  '反馈意见：____________________________________________________',
];

/** 附件主机拒绝时返回的 HTML 拦截页，URL 却以 .pdf 结尾（判型看文件头，不看扩展名）。 */
const BLOCK_PAGE =
  '<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body>' +
  'Access denied. Your IP is blocked by the security gateway.</body></html>\n';

const latin1 = (text) => Buffer.from(text, 'latin1');
/** OLE2 头部里的 Word 主流名（以 UTF-16LE 存放），magic 靠它把 .doc 与 .xls 分开。 */
const WORD_STREAM_MARKER = 'WordDocument';
const escapePdf = (text) => text.replace(/[\\()]/g, (char) => `\\${char}`);
const escapeXml = (text) =>
  text.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);

/**
 * 拼出合法 PDF。xref 偏移按**字节**实算（差一个字节阅读器就报损坏），所以对象体
 * 允许是字符串（字典与文本流）或 Buffer 片段数组（图片流里是二进制）。
 */
function assemblePdf(objectBodies) {
  const header = latin1('%PDF-1.4\n');
  const chunks = [header];
  const offsets = [];
  let cursor = header.length;

  objectBodies.forEach((body, index) => {
    offsets.push(cursor);
    const open = latin1(`${index + 1} 0 obj\n`);
    const middle = typeof body === 'string' ? latin1(body) : Buffer.concat(body);
    const close = latin1('\nendobj\n');
    chunks.push(open, middle, close);
    cursor += open.length + middle.length + close.length;
  });

  const table = `xref\n0 ${objectBodies.length + 1}\n0000000000 65535 f \n`;
  const entries = offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  const trailer = `trailer\n<< /Size ${objectBodies.length + 1} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`;
  return Buffer.concat([...chunks, latin1(table + entries + trailer)]);
}

/** 文本型 PDF：每页一段 Tj 文本行，共享一个标准字体。 */
function buildTextPdf(pages) {
  const firstPageNum = 3;
  const contentStart = firstPageNum + pages.length;
  const fontNum = contentStart + pages.length;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${firstPageNum + i} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  ];
  pages.forEach((_, i) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentStart + i} 0 R` +
        ` /Resources << /Font << /F1 ${fontNum} 0 R >> >> >>`,
    );
  });
  for (const lines of pages) {
    const stream =
      'BT /F1 12 Tf 56 780 Td 16 TL\n' + lines.map((line) => `(${escapePdf(line)}) Tj T*`).join('\n') + '\nET';
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  return assemblePdf(objects);
}

/**
 * 扫描型 PDF：每页一张铺满页面的位图，没有任何文本算子 —— 对应「把红头文件扫描件
 * 打印成 PDF」那类附件：合法、打得开，但抽不出字。
 */
function buildScanOnlyPdf(pageCount) {
  const width = 16;
  const height = 16;
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 31) % 251;
  const image = deflateSync(pixels);

  const firstPageNum = 3;
  const contentNum = firstPageNum + pageCount;
  const imageNum = contentNum + 1;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${firstPageNum + i} 0 R`).join(' ')}] /Count ${pageCount} >>`,
  ];
  for (let i = 0; i < pageCount; i += 1) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentNum} 0 R` +
        ` /Resources << /XObject << /Im0 ${imageNum} 0 R >> >> >>`,
    );
  }
  const stream = 'q 595 0 0 842 0 0 cm /Im0 Do Q';
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  objects.push([
    latin1(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height}` +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode' +
        ` /Length ${image.length} >>\nstream\n`,
    ),
    image,
    latin1('\nendstream'),
  ]);
  return assemblePdf(objects);
}

/** 最小可用 DOCX：正文段落 + 关系文件。 */
function buildDocx(paragraphs) {
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`)
    .join('');
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body></w:document>`;

  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '</Types>',
      ),
      '_rels/.rels': strToU8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          '</Relationships>',
      ),
      'word/document.xml': strToU8(document),
    }),
  );
}

/**
 * OLE2 头 + 垃圾扇区。刻意把 `WordDocument` 流名以 UTF-16LE 写进头部：
 * magic 因此判成 doc（而不是 other），才会真的走到 word-extractor 并抛错 ——
 * 这钉的是「认得出是 Word 文件但读不动」这条路。
 */
function buildBrokenDoc() {
  const header = Buffer.alloc(512, 0);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x003e, 24);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  const marker = Buffer.alloc(WORD_STREAM_MARKER.length * 2);
  for (let i = 0; i < WORD_STREAM_MARKER.length; i += 1) marker.writeUInt16LE(WORD_STREAM_MARKER.charCodeAt(i), i * 2);
  marker.copy(header, 512 - marker.length);
  return Buffer.concat([header, latin1('not-a-real-compound-file'.repeat(32))]);
}

const FILES = {
  'draft.pdf': buildTextPdf(PDF_PAGES),
  'draft.docx': buildDocx(DRAFT_DOCX),
  'blank-form.docx': buildDocx(BLANK_FORM_DOCX),
  'scan-only.pdf': buildScanOnlyPdf(5),
  'block.pdf': latin1(BLOCK_PAGE),
  'broken.doc': buildBrokenDoc(),
};

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, content] of Object.entries(FILES)) {
  writeFileSync(path.join(OUT_DIR, name), content);
  console.log(`${name.padEnd(18)} ${String(content.length).padStart(6)} 字节`);
}
console.log(
  existsSync(path.join(OUT_DIR, 'cjk-text.pdf'))
    ? 'cjk-text.pdf        外部打印的真实中文 PDF，本脚本不改写'
    : '⚠ 缺 cjk-text.pdf：中文文本 PDF 主路径没有夹具覆盖（见文件头说明）',
);
