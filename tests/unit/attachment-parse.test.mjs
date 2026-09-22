import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MAX_STORED_TEXT_CHARS, parseAttachment } from '../../src/lib/attachments/parse.ts';
import { detectAttachmentKind } from '../../src/lib/file-magic.ts';

/**
 * 单元：附件本文抽取（issue #57）。
 *
 * 这一层的失效方式不是「抛异常」而是「静默抽出空」—— 扫描版 PDF、缺 ToUnicode 的中文
 * 字体、结构不合规的 WPS .doc 都会合法地返回空。所以每条断言都要么钉住「抽出了具体的
 * 那几个字」，要么钉住「落到了哪个终态」，不写「长度 > 0」这种永远绿的糊弄断言。
 *
 * 夹具是真文件（见 scripts/make-attachment-fixtures.mjs 与 fixtures 目录说明），
 * 其中 cjk-text.pdf 是 Edge 打印出来的中文 PDF —— 它钉的是本项目最主要的那条路径：
 * 一份中文条文 PDF 到底能不能出字。
 */

const FIXTURES = 'fixtures/e2e-attachments';
const read = (name) => new Uint8Array(readFileSync(path.join(FIXTURES, name)));

async function parseFixture(name, kind = detectAttachmentKind(read(name))) {
  const body = read(name);
  const result = await parseAttachment({ kind, body });
  return { result, body };
}

const hanzi = (text) => (text.match(/[㐀-䶿一-鿿豈-﫿]/g) ?? []).length;

describe('PDF 抽取', () => {
  it('中文文本型 PDF 抽得出条文、「适用范围」与反馈方式', async () => {
    const { result } = await parseFixture('cjk-text.pdf');
    assert.equal(result.status, 'ok');
    assert.equal(result.pages, 2);
    assert.ok(result.charCount > 600, `一份真征求意见稿只抽出 ${result.charCount} 字，说明取文本路径断了`);
    assert.ok(result.text.includes('第二条 适用范围'), `没抽到条号与适用范围：${result.text.slice(0, 80)}`);
    assert.ok(
      result.text.includes('电子邮箱：jianzhu@example.gov.cn'),
      '渠道段依赖附件里的反馈方式，抽不到就还是只能靠页面正文那几句',
    );
    assert.ok(result.text.includes('截止日期为：2026 年 10 月 7 日'));
  });

  it('扫描型 PDF 判成 scanned_no_text，不是 ok（合法文件但没字）', async () => {
    const { result } = await parseFixture('scan-only.pdf');
    assert.equal(result.status, 'scanned_no_text');
    assert.equal(result.charCount, 0);
    assert.equal(result.pages, 5, '页数要带出来：审计脚本靠它区分扫描件与大文件');
    assert.ok(result.error, '终态要能解释自己，否则生产上无从下手');
  });

  it('结构锚点不粘成一行（pdfjs 的 hasEOL 要落成换行）', async () => {
    const { result } = await parseFixture('cjk-text.pdf');
    const lines = result.text.split('\n');
    // 只断言「行数 >= 3」是假绿：不照 hasEOL 换行时页与页之间仍有换行，一份 20 段的
    // 征求意见稿也会报 3 行。所以钉的是**单行长度**与**行数下限**这一对。
    assert.ok(lines.length >= 20, `抽出来只剩 ${lines.length} 行，段落结构没保住`);
    assert.ok(
      Math.max(...lines.map((line) => line.length)) < 120,
      '出现超长行说明整页被粘成一行，「第X条」这类锚点此后再也切不出来',
    );
  });

  it('英文文本夹具的段落也分行，并保留结构锚点', async () => {
    const { result } = await parseFixture('draft.pdf');
    assert.equal(result.status, 'ok');
    assert.ok(result.text.includes('Scope of application'));
    assert.ok(result.text.split('\n').length >= 5);
  });

  it('坏 PDF 不抛异常，落到 unsupported_container', async () => {
    const body = new Uint8Array(2048).fill(0x41);
    body.set([0x25, 0x50, 0x44, 0x46], 0);
    const result = await parseAttachment({ kind: 'pdf', body });
    assert.equal(result.status, 'unsupported_container');
    assert.equal(result.text, '');
  });
});

describe('DOCX 抽取', () => {
  it('草稿正文与反馈渠道都在，段落分开', async () => {
    const { result } = await parseFixture('draft.docx');
    assert.equal(result.status, 'ok');
    assert.ok(result.text.includes('第二条 适用范围'));
    assert.ok(result.text.includes('电子邮箱：test@example.gov.cn'));
    assert.ok(result.text.includes('起草说明'));
    assert.ok(result.text.split('\n').length >= 8);
    assert.equal(result.pages, null);
  });

  it('XML 实体要还原（地址里的 & 在 document.xml 里是转义过的）', async () => {
    const body = await buildDocxAsync(['联系方式：a@b.gov.cn &amp; c@d.gov.cn &lt;附件&gt;']);
    const result = await parseAttachment({ kind: 'docx', body });
    assert.ok(result.text.includes(' & '), `&amp; 没还原：${result.text}`);
    assert.ok(result.text.includes(' <附件>'), `&lt; 没还原：${result.text}`);
  });

  it('空白意见表仍算解析成功，但汉字数远低于 no_draft_text 阈值', async () => {
    const { result } = await parseFixture('blank-form.docx');
    assert.equal(result.status, 'ok', '空白表是「读到了但没内容」，不是读不了');
    assert.ok(hanzi(result.text) < 400, '任务层用 400 汉字判 no_draft_text，这条断言钉住它的输入');
  });

  it('zip 里确实没有正文条目时判 unsupported_container（Content_Types 齐但缺 document.xml）', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const body = new Uint8Array(
      zipSync({
        '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
        'xl/workbook.xml': strToU8('<workbook/>'),
      }),
    );
    assert.equal(detectAttachmentKind(body), 'docx', '判型只看 OOXML 标记，分不出 xlsx —— 所以这一层必须自己兜住');
    const result = await parseAttachment({ kind: 'docx', body });
    assert.equal(result.status, 'unsupported_container');
    assert.ok(result.error.includes('document.xml'));
  });

  it('坏 zip 不抛异常', async () => {
    const body = new Uint8Array(512).fill(0x50);
    body.set([0x50, 0x4b, 0x03, 0x04], 0);
    const result = await parseAttachment({ kind: 'docx', body });
    assert.equal(result.status, 'unsupported_container');
  });
});

describe('legacy .doc 抽取', () => {
  it('OLE 结构不合规时判 unsupported_container 并把原因带出来', async () => {
    const { result } = await parseFixture('broken.doc');
    assert.equal(result.status, 'unsupported_container');
    assert.ok(result.error.includes('legacy .doc'), `错误要说明是哪条路径：${result.error}`);
  });
});

describe('契约', () => {
  it('四种类型都不会抛异常出去（任务层因此可以无分支写库）', async () => {
    for (const kind of ['pdf', 'docx', 'doc', 'other']) {
      const result = await parseAttachment({ kind, body: new Uint8Array(64).fill(0x20) });
      assert.ok(
        ['ok', 'scanned_no_text', 'unsupported_container'].includes(result.status),
        `${kind} 返回了非法终态 ${result.status}`,
      );
    }
  });

  it('不吃掉调用方的字节（pdfjs 会移交 data 缓冲，哈希必须在解析后仍然算得出同一个值）', async () => {
    const body = read('draft.pdf');
    const before = createHash('sha256').update(body).digest('hex');
    await parseAttachment({ kind: 'pdf', body });
    assert.equal(body.byteLength, read('draft.pdf').byteLength, '缓冲被移交走了，byteLength 归零');
    assert.equal(createHash('sha256').update(body).digest('hex'), before);
  });

  it('超长文本截到入库上限（60 页标准全文可达 20 万字）', async () => {
    assert.ok(MAX_STORED_TEXT_CHARS > 1000);
    const line = '第X条 本办法适用于从事建筑市场信用管理活动的企业、事业单位和社会公众，各级主管部门负责本行政区域内的信用管理工作。';
    const paragraphs = Array.from({ length: Math.ceil(MAX_STORED_TEXT_CHARS / line.length) + 20 }, () => line);
    const body = await buildDocxAsync(paragraphs);
    const result = await parseAttachment({ kind: 'docx', body });
    assert.ok(result.text.length > MAX_STORED_TEXT_CHARS - line.length, '没截断就会把 20 万字整篇塞进数据库');
    assert.equal(result.text.length, MAX_STORED_TEXT_CHARS);
  });
});

/** 用一个最小 docx 生成器现造内容（只为验实体与截断，不新增二进制夹具）。 */
async function buildDocxAsync(paragraphs) {
  const { strToU8, zipSync } = await import('fflate');
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
  return new Uint8Array(
    zipSync({
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
      'word/document.xml': strToU8(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          `<w:body>${body}</w:body></w:document>`,
      ),
    }),
  );
}
