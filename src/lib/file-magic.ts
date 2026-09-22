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

/** docx 是 zip 容器。曾经想靠条目名嗅探来分 docx / xlsx，实测证明那条路不成立，见下。 */

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46]; // %PDF
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04（本地文件头）
const ZIP_EMPTY_SIGNATURE = [0x50, 0x4b, 0x05, 0x06]; // 空归档
const OLE2_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(head: Uint8Array, signature: readonly number[]): boolean {
  if (head.length < signature.length) return false;
  return signature.every((byte, index) => head[index] === byte);
}

/**
 * 判附件类型。入参是文件头（前若干 KiB 即可，不必整档）。
 *
 * **zip 与 OLE2 都不在判型阶段细分**，同一理由（各被生产实测打过一次）：
 * - zip：2026-09-22 影子轮，住建部 20 个真 docx 被「前 1024 字节找 `[Content_Types].xml`」
 *   全部拒掉 —— 那个包的条目顺序是 `docProps/` 在前。条目顺序由打包器决定，规范没保证；
 *   而中央目录在**文件末尾**，只有前 64KiB 的探测阶段根本读不到。
 * - OLE2：同一轮里 caac / samr 的 .doc 与 .wps 被「前 4096 字节找 UTF-16LE 的
 *   `WordDocument` 流名」拒掉 —— OLE 的流名在**目录项**里，目录项落在哪个扇区由 FAT
 *   决定，不在文件头部固定位置。
 *
 * 细分留给解析层：它拿到整档，能给出准确结论（「zip 里没有 word/document.xml」、
 * 「legacy .doc 解析失败：…」）。而打分层已按扩展名把 zip / xls* 挡在下载之前。
 */
export function detectAttachmentKind(head: Uint8Array): AttachmentKind {
  if (startsWith(head, PDF_SIGNATURE)) return 'pdf';
  if (startsWith(head, ZIP_SIGNATURE) || startsWith(head, ZIP_EMPTY_SIGNATURE)) return 'docx';
  if (startsWith(head, OLE2_SIGNATURE)) return 'doc';
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
