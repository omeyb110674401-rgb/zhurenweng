/**
 * 附件本文抽取（issue #57）—— 把 pdf / docx / doc 变成一段可以直接喂给摘要模型的纯文本。
 *
 * 三条硬约束决定了这里为什么是这几个库：
 * 1. 依赖必须纯 JS。两个镜像都跑 `npm ci --ignore-scripts`（Dockerfile），任何带
 *    postinstall / node-gyp 的包（mupdf、pdftotext 绑定）装上就是坏的。
 * 2. 抽不出字**不是异常，是结论**。扫描版 PDF、空白意见表、加密文件都会「格式合法、
 *    内容为空」，必须各自落到不同终态，任务层才能对失败面出数（见 `db/types.ts` 的
 *    `AttachmentExtractStatus`）。
 * 3. 只有 `src/lib/attachments/**` 与 `worker/**` 能导入本模块（eslint
 *    `no-restricted-imports`）—— pdfjs 解包 35MB，静态挂到 web 运行期包上是纯浪费。
 *    因此两个重型依赖都是**动态 import**：只处理 docx 的那一轮不会为 pdfjs 付出加载成本。
 *
 * 实测过的三件事（决定了下面的选项，别凭印象改）：
 * - **扫描型 PDF 抽出 0 字符且不报错**（Downloads 里三份真实 PDF 都是这种：每页一张位图、
 *   没有文本算子）。所以「解析成功」不能等于「有字」，得有 scanned_no_text 这个独立终态。
 * - **pdfjs 会把 `data` 缓冲移交走**：解析后调用方那份 Uint8Array 的 byteLength 变 0。
 * - 中文文本型 PDF（用 Edge `--print-to-pdf` 打的一份，见 fixtures 说明）带不带 cMaps
 *   都能出字 —— 因为它内嵌了 ToUnicode。`cMapUrl` 服务的是**没有** ToUnicode 的那类
 *   CID 字体（WPS 与老版生成器的常见产物），这类文件本地没测到，配置留着，
 *   生产实测时按 `scanned_no_text` / 0 字段的分布回看它有没有真的救到条目。
 */
import { unzipSync } from 'fflate';
import type { AttachmentKind } from '../../db/types.ts';

/** 入库前截断。60 页标准全文可达 20 万字，而进提示词的只有几千字（截取见 attachment-select）。 */
export const MAX_STORED_TEXT_CHARS = 200_000;

/** 扫描件判据：页数超过它、平均每页字数低于它，就当图像型 PDF。 */
export const SCANNED_MIN_PAGES = 3;
export const SCANNED_MAX_CHARS_PER_PAGE = 20;

/** 一次抽取的结论。`status` 之外都是给任务层与审计脚本看的原始数字。 */
export interface AttachmentParseResult {
  status: 'ok' | 'scanned_no_text' | 'unsupported_container';
  /** 抽取文本；`unsupported_container` 时为空串 */
  text: string;
  /**
   * **去空白后的字符数**（`text.replace(/\s/g,'').length`）。
   *
   * ⚠️ 它**不是** `notice_attachments.char_count` 那一列的值：那一列存的是**汉字数**
   * （`countCjk(text)`，见 `worker/jobs/extract-attachments.ts`），因为「有没有条文正文」
   * 的判据（`hasDraftText`）与喂入预算都以汉字计。两处同名不同义，本字段目前**没有任何读侧**
   * （2026-09-27 第 3 刀实测时发现，登记在 `docs/pending-issues/FOLLOWUPS.md`）。
   * 原始注释写的是"扫描件判据与 `char_count` 列都用它"，那句话是错的。
   */
  charCount: number;
  /** PDF 页数，非 PDF 为 null */
  pages: number | null;
  /** 失败原因（进 `notice_attachments.error`，人读的） */
  error: string | null;
}

function charCountOf(text: string): number {
  return text.replace(/\s/g, '').length;
}

/**
 * 清洗抽取文本里的非文字字符。
 *
 * 生产实测（2026-09-22 影子轮）：生态环境部一份 11 页标准 PDF 抽出 8 个 U+0000 ——
 * 字体映射失败时 pdfjs 会吐空字符 —— 而 **PostgreSQL 的 text 不允许 NUL**，于是那条
 * UPDATE 直接失败、整个抽取任务中断。孤立代理对同理（编码成 UTF-8 会失败）。
 * 这些字符对摘要毫无信息量，删掉没有损失；不删就会让一个坏文件拖垮一整轮。
 */
export function sanitizeExtractedText(text: string): string {
  let out = '';
  // 必须按**码点**迭代：按 code unit 迭代会把增补平面的合法代理对也当成孤立代理删掉
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char.length === 2) {
      out += char;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdfff) continue;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if (code >= 0x80 && code <= 0x9f) continue;
    out += char;
  }
  return out;
}

function finish(
  status: AttachmentParseResult['status'],
  text: string,
  pages: number | null,
  error: string | null = null,
): AttachmentParseResult {
  const clean = sanitizeExtractedText(text);
  const clipped = clean.length > MAX_STORED_TEXT_CHARS ? clean.slice(0, MAX_STORED_TEXT_CHARS) : clean;
  return { status, text: clipped, charCount: charCountOf(clipped), pages, error };
}

/** cMaps / 标准字体目录：pdfjs 靠它们才能把 CID 字体映射成汉字。 */
function pdfAssetUrl(subdir: string): string {
  return new URL(subdir + '/', import.meta.resolve('pdfjs-dist/package.json')).href;
}

async function extractPdf(body: Uint8Array): Promise<AttachmentParseResult> {
  const { getDocument, VerbosityLevel } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = getDocument({
    // 必须是**朴素 Uint8Array**，两个理由都实测踩过：
    // 1. pdfjs v6 见到 Buffer 直接抛「Please provide binary data as `Uint8Array`,
    //    rather than `Buffer`」—— 而下载侧 `readCappedBuffer` 返回的正是 Buffer；
    // 2. pdfjs 会把 `data` 这个缓冲**移交走**（解析后调用方那份的 byteLength 变 0）。
    //    任务层拿同一份字节算 content_hash，被移走的话所有 PDF 会得到同一个「空文件哈希」，
    //    跨轮缓存变成永久性假命中。
    // `new Uint8Array(body)` 一次同时解决这两条：它是复制，不是视图。
    data: new Uint8Array(body),
    disableFontFace: true,
    cMapUrl: pdfAssetUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: pdfAssetUrl('standard_fonts'),
    verbosity: VerbosityLevel.ERRORS,
  });
  try {
    const doc = await loadingTask.promise;
    const pages = doc.numPages;
    const parts: string[] = [];
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      // hasEOL 是 pdfjs 给的行尾提示：不照它换行的话整页会粘成一行，
      // 「第X条」这类结构锚点就再也切不开了。
      let line = '';
      for (const item of content.items) {
        line += 'str' in item ? item.str : '';
        if ('hasEOL' in item && item.hasEOL) {
          parts.push(line);
          line = '';
        }
      }
      if (line !== '') parts.push(line);
      parts.push('');
    }
    // 先清洗再判扫描件：一份「全文只有空字符」的 PDF 如果按清洗后的长度算，会被判成
    // scanned_no_text；按清洗前算则成了 ok 但文本是空的 —— 后者正是我们要杜绝的静默失效。
    const text = sanitizeExtractedText(parts.join('\n').replace(/\n{3,}/g, '\n\n').trim());
    const chars = charCountOf(text);
    if (pages >= SCANNED_MIN_PAGES && chars / pages < SCANNED_MAX_CHARS_PER_PAGE) {
      return finish('scanned_no_text', text, pages, `每页平均 ${Math.round(chars / pages)} 字，判为扫描版`);
    }
    return finish('ok', text, pages, chars === 0 ? 'PDF 里没有任何文字层' : null);
  } finally {
    // 不销毁会留着解析器与字体缓存：worker 一轮要过上百个文件。
    await loadingTask.destroy();
  }
}

/** 段落结束标签换成换行，其余标签删掉，最后只保留文本节点。 */
function docxParagraphs(bodyXml: string): string {
  const withoutNoise = bodyXml
    .replace(/<w:instrText(?:\s[^>]*)?>[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<w:delText(?:\s[^>]*)?>[\s\S]*?<\/w:delText>/g, '')
    .replace(/<w:tab(?:\s[^>]*)?\s*\/>/g, ' ')
    .replace(/<w:(?:br|cr)(?:\s[^>]*)?\s*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n');
  return decodeXmlEntities(withoutNoise.replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const XML_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity === 'amp') return '&';
    const named = XML_ENTITIES[entity];
    if (named !== undefined) return named;
    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(
        entity[1] === 'x' || entity[1] === 'X' ? entity.slice(2) : entity.slice(1),
        entity[1] === 'x' || entity[1] === 'X' ? 16 : 10,
      );
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : whole;
    }
    return whole;
  });
}

function extractDocx(body: Uint8Array): AttachmentParseResult {
  // 只解正文那一个条目：附件里的图片能占九成体积，而我们要的只是文字。
  const entries = unzipSync(body, { filter: (file) => file.name === 'word/document.xml' });
  const document = entries['word/document.xml'];
  if (document === undefined) {
    return finish('unsupported_container', '', null, 'zip 里没有 word/document.xml（可能是 xlsx 或 pptx）');
  }
  const text = docxParagraphs(new TextDecoder('utf-8').decode(document));
  if (text === '') {
    return finish('unsupported_container', '', null, '正文 XML 解析后为空');
  }
  return finish('ok', text, null);
}

async function extractDoc(body: Uint8Array): Promise<AttachmentParseResult> {
  const { default: WordExtractor } = await import('word-extractor');
  try {
    const document = await new WordExtractor().extract(Buffer.from(body));
    const text = document.getBody().replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text === '') return finish('unsupported_container', '', null, 'OLE 复合文档里没有可读的 WordDocument 流');
    return finish('ok', text, null);
  } catch (error) {
    // WPS 与老版本 Word 写出的 .doc 里有一部分结构不合 OLE 规范，word-extractor 直接抛。
    // 这是预期的失效方式，所以留在 catch 里而不是让它冒到任务层。
    return finish('unsupported_container', '', null, `legacy .doc 解析失败：${messageOf(error)}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 抽取附件本文。`kind` 由文件头判定（见 `lib/file-magic.ts`），不看扩展名。
 *
 * **不抛异常是这层的契约**：任务层要对着上百个来源混杂的文件写库，任何一条抛出来都会
 * 把整轮抽取带崩（并把条目打成 failed_review）。政府站点上截断的下载、加密的 PDF、
 * 扩展名与内容不符的文件都是常态，所以最外层兜一次，一律翻译成 `unsupported_container`。
 */
export async function parseAttachment(input: {
  kind: AttachmentKind;
  body: Uint8Array;
}): Promise<AttachmentParseResult> {
  try {
    switch (input.kind) {
      case 'pdf':
        return await extractPdf(input.body);
      case 'docx':
        return extractDocx(input.body);
      case 'doc':
        return await extractDoc(input.body);
      case 'other':
        return finish('unsupported_container', '', null, '不是 pdf / docx / doc 容器');
    }
  } catch (error) {
    return finish('unsupported_container', '', null, `${input.kind} 解析抛错：${messageOf(error)}`);
  }
}
