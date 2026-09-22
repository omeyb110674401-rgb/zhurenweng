import type { AttachmentKind } from '../db/types.ts';

/**
 * 按文件头判类型（issue #57）—— 不看扩展名，也不看 Content-Type。
 *
 * 为什么不看扩展名：cac / mohurd 的附件名根本没有扩展名（生产 340 个附件名里 264 个
 * 没有），文件名藏在 `fileName=` 查询参数里；反过来，扩展名是 `.pdf` 而响应体是
 * 1,335 字 CDN 拦截页的情况也已经实测到。
 * 为什么不看 Content-Type：政务站大量把 docx 报成 `application/octet-stream`，
 * 也有把 HTML 错误页报成 `application/pdf` 的。
 *
 * 判不出来不是失败而是常态：`other` 表示「不是我们能读的那三种容器」，
 * 任务层据此直接落终态，不发第二个请求。
 */

/** 判型至少需要读的字节数（OLE2 的签名就有 8 字节）。 */
export const MAGIC_PROBE_BYTES = 8;

/** docx 是 zip 容器，靠首个条目名识别（Word 写文件时 `[Content_Types].xml` 总在开头）。 */
const OOXML_MARKER = '[Content_Types].xml';
/** 旧版 Word 的主流名，UTF-16LE 写在 OLE2 头部（WPS 生成的 .doc 同样有）。 */
const WORD_STREAM_MARKER = 'WordDocument';

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46]; // %PDF
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04（本地文件头）
const ZIP_EMPTY_SIGNATURE = [0x50, 0x4b, 0x05, 0x06]; // 空归档
const OLE2_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(head: Uint8Array, signature: readonly number[]): boolean {
  if (head.length < signature.length) return false;
  return signature.every((byte, index) => head[index] === byte);
}

/**
 * 在前 `limit` 字节里找一段 ASCII 标记。
 *
 * 只用于 zip 条目名：它们在本地文件头里是明文，且我们最关心的两个条目
 * （`[Content_Types].xml` / `word/document.xml`）必然排在前面。不做完整中央目录
 * 解析 —— 那要为「区分 docx 和 xlsx」写一个 zip 阅读器，而打分层已经把 xls 丢了。
 */
function findAscii(head: Uint8Array, marker: string, limit: number): boolean {
  const bytes = new TextDecoder('latin1').decode(head.subarray(0, Math.min(head.length, limit)));
  return bytes.includes(marker);
}

/** OLE2 里的流名以 UTF-16LE 存放，逐字节比对（避免为一次判定构造一个大字符串）。 */
function findUtf16Ascii(head: Uint8Array, marker: string): boolean {
  for (let start = 0; start + marker.length * 2 <= head.length; start += 2) {
    let matched = true;
    for (let index = 0; index < marker.length; index += 1) {
      if (head[start + index * 2] !== marker.charCodeAt(index) || head[start + index * 2 + 1] !== 0) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * 判附件类型。入参是文件头（前若干 KiB 即可，不必整档）。
 *
 * `docx` 的判定刻意保守：zip 里看不到 OOXML 标记就报 `other`，而不是猜一个 docx ——
 * 猜错的代价是白解析一次并给出一条 `unsupported_container` 的假失败记录。
 */
export function detectAttachmentKind(head: Uint8Array): AttachmentKind {
  if (startsWith(head, PDF_SIGNATURE)) return 'pdf';
  if (startsWith(head, ZIP_SIGNATURE) || startsWith(head, ZIP_EMPTY_SIGNATURE)) {
    return findAscii(head, OOXML_MARKER, 1024) ? 'docx' : 'other';
  }
  if (startsWith(head, OLE2_SIGNATURE)) {
    return findUtf16Ascii(head.subarray(0, 4096), WORD_STREAM_MARKER) ? 'doc' : 'other';
  }
  return 'other';
}

/**
 * 是不是 HTML 文档（拦截页 / 错误页 / 把附件链接指向了网页）。
 *
 * 为什么单独导出而不并进 `other`：任务层要据此区分「源站给了个网页」（not_a_file，
 * 换 IP 或换时间可能就好）和「给了个我们不支持的二进制」（换 IP 也没用）。
 *
 * 为什么按 latin1 解：只需要认得开头的 ASCII 标签，而 latin1 是单字节无损映射 ——
 * 换成 utf-8 解码，政务站常见的 GBK 页面会解出一堆替换字符，标签本身反而可能被打断。
 */
export function looksLikeHtml(head: Uint8Array): boolean {
  if (head.length === 0) return false;
  // UTF-8 BOM 是 EF BB BF 三个**字节**（latin1 解出来是「ï»¿」，不是 U+FEFF 一个字符），
  // 不去掉它开头的 <!doctype 就永远匹配不上。
  const from = head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  const text = new TextDecoder('latin1')
    .decode(head.subarray(from, Math.min(head.length, from + 256)))
    .trimStart()
    .toLowerCase();
  return (
    text.startsWith('<!doctype html') ||
    text.startsWith('<html') ||
    text.startsWith('<head') ||
    text.startsWith('<body') ||
    text.startsWith('<p>')
  );
}
