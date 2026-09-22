import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MAGIC_PROBE_BYTES, detectAttachmentKind, looksLikeHtml } from '../../src/lib/file-magic.ts';

/**
 * 单元：附件判型与「是不是网页」（issue #57）。
 *
 * 判型只看文件头，是因为生产实测的两件事都反直觉：
 * 1. cac / mohurd 的附件名**根本没有扩展名**（340 个附件名里 264 个没有），文件名藏在
 *    `fileName=` / `fText=` 查询参数里；
 * 2. 反过来，扩展名写着 `.pdf` 而响应体是 HTML 拦截页也确实存在（`block.pdf` 夹具就是照它做的）。
 * 「按扩展名分派解析器」在第一批真实数据上就会错一半，所以这几条断言钉的是判型依据本身。
 */

const FIXTURES = 'fixtures/e2e-attachments';
const ascii = (text) => Uint8Array.from(text, (char) => char.charCodeAt(0));
const utf16 = (text) => new Uint8Array(Buffer.from(text, 'utf16le'));
const concat = (...parts) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
const fixtureHead = (name, length = 4096) =>
  new Uint8Array(readFileSync(path.join(FIXTURES, name))).subarray(0, length);

const OLE2 = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const OOXML_ZIP = concat(ascii('PK\u0003\u0004'), new Uint8Array(26), ascii('[Content_Types].xml'));

describe('detectAttachmentKind：只认文件头，不认扩展名', () => {
  it('%PDF 开头判成 pdf', () => {
    assert.equal(detectAttachmentKind(ascii('%PDF-1.7\n')), 'pdf');
  });

  it('zip 容器要看到 OOXML 标记才算 docx；看不到就是 other，不猜', () => {
    assert.equal(detectAttachmentKind(OOXML_ZIP), 'docx');
    assert.equal(
      detectAttachmentKind(concat(ascii('PK\u0003\u0004'), new Uint8Array(26), ascii('xl/workbook.xml'))),
      'other',
      '把 xlsx 猜成 docx 会白解析一次，并留下一条假的 unsupported_container 记录',
    );
  });

  it('OLE2 容器要看到 UTF-16LE 的 WordDocument 流名才算 doc', () => {
    assert.equal(detectAttachmentKind(concat(OLE2, new Uint8Array(500), utf16('WordDocument'))), 'doc');
    assert.equal(detectAttachmentKind(concat(OLE2, new Uint8Array(500), utf16('Workbook'))), 'other');
  });

  it('真实夹具各判成自己的类型（含无扩展名可用的情形）', () => {
    assert.equal(detectAttachmentKind(fixtureHead('draft.pdf')), 'pdf');
    assert.equal(detectAttachmentKind(fixtureHead('cjk-text.pdf')), 'pdf');
    assert.equal(detectAttachmentKind(fixtureHead('scan-only.pdf')), 'pdf');
    assert.equal(detectAttachmentKind(fixtureHead('draft.docx')), 'docx');
    assert.equal(detectAttachmentKind(fixtureHead('broken.doc')), 'doc');
  });

  it('伪装成 .pdf 的拦截页判成 other —— 扩展名在这里是彻底的假证据', () => {
    assert.equal(detectAttachmentKind(fixtureHead('block.pdf')), 'other');
  });

  it('字节数不足时不抛错，一律 other', () => {
    assert.ok(MAGIC_PROBE_BYTES > 0, '至少得读完签名长度');
    assert.equal(detectAttachmentKind(ascii('%P')), 'other');
    assert.equal(detectAttachmentKind(new Uint8Array(0)), 'other');
  });
});

describe('looksLikeHtml：区分「源站给了个网页」与「给了个读不了的二进制」', () => {
  it('UTF-8 BOM、前导空白、大小写都不影响判定', () => {
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf]);
    assert.equal(looksLikeHtml(concat(bom, ascii('\n<!DOCTYPE HTML><html>'))), true);
    assert.equal(looksLikeHtml(ascii('   <HTML lang="zh">')), true);
    assert.equal(looksLikeHtml(ascii('<head><title>提示</title></head>')), true);
  });

  it('PDF 字节里恰好出现 <body> 不算网页（必须开头是标签）', () => {
    // 要落在判定期扫描的前 256 字节**之内**：放更远处的话这条测试就只是在验窗口宽度，
    // 而不是在验「锚定开头」这件事本身。
    assert.equal(looksLikeHtml(concat(ascii('%PDF-1.7\n'), ascii('x'.repeat(60)), ascii('<body>x</body>'))), false);
    assert.equal(looksLikeHtml(ascii('<body>直接以 body 开头拦截页</body>')), true);
  });

  it('空响应不算网页（要留给 error 而不是 not_a_file）', () => {
    assert.equal(looksLikeHtml(new Uint8Array(0)), false);
  });
});
