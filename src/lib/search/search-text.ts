import type { NoticeRecord } from '../../db/types.ts';
import { parseQuotedSummary } from '../summary-content.ts';
import type { SearchDocument } from '../ports.ts';

/**
 * 检索文本处理（issue #8）：SearchPort 本地实现（SQLite FTS5）与
 * Meilisearch 适配器共用的「文档构建 + 查询归一化」工具。
 *
 * 中文检索策略（FTS5 unicode61 分词器对连续汉字只建一个长词、无法子串命中）：
 * 索引写入前在汉字与相邻词元字符（汉字 / 字母 / 数字）之间插入空格，让每个汉字
 * 成为独立词元；查询时把用户的中文连续片段还原为同规则的短语（phrase）查询 ——
 * 短语相邻性等价于原文本的连续子串，中文关键词因此能以子串语义命中标题 / 摘要 /
 * 正文（含英文单词的前缀匹配兜底）。Meilisearch 自带中文分词，直接使用原始文本即可。
 */

/** CJK 统一表意文字（含扩展 A 区与兼容区）：检索的核心字符范围 */
const CJK_CHAR = '[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]';
/**
 * 需要插入分隔空格的相邻字符对：汉字↔汉字，以及汉字↔字母数字（双向）。
 *
 * unicode61 把汉字与 ASCII 字母数字都算作词元字符，因此「前门西大街1号」
 * 「等2项」「修订HJ808」这类紧邻写法会被合成一个词元（如「街1号」），
 * 短语查询在汉字与数字的交界处就匹配不到（issue #15 缺陷 1：正文里明明有
 * 「前门西大街」，检索却零命中）。此处把两类字符的交界也拆开。
 *
 * 两条分支都用前瞻断言（lookahead）匹配边界、不消耗右侧字符，因此交替出现的
 * 「汉字ABC汉字」也能逐处命中（若改用消耗式成对匹配，相邻边界会隔一个漏一个）。
 */
const WORD_BOUNDARY = new RegExp(
  `(${CJK_CHAR})(?=[\\p{L}\\p{N}])|([\\p{L}\\p{N}])(?=${CJK_CHAR})`,
  'gu',
);
/** 连续汉字片段（用于解析查询词） */
const CJK_RUN = new RegExp(`${CJK_CHAR}+`, 'g');
/** 连续 ASCII 字母数字片段（英文 / 数字关键词，走前缀匹配） */
const ASCII_RUN = /[A-Za-z0-9]+/g;

/**
 * 索引写入前的文本变换：在汉字与相邻词元字符（汉字 / 字母 / 数字）之间插入空格。
 * unicode61 以空白为分隔符，汉字因此按「单字词元」建索引，数字与字母保持原样
 * （按词命中）—— 短语相邻性因此等价于原文本的连续子串，含数字的中文短语
 * 也能命中（见 buildFts5MatchQuery）。
 */
export function toCjkSpacedText(text: string): string {
  return text.replace(WORD_BOUNDARY, (match) => `${match} `);
}

/**
 * 把用户查询归一化为 FTS5 MATCH 表达式：
 * - 每段连续汉字 → 按字拆分的短语查询（如「医疗保障」→ `"医 疗 保 障"`）；
 * - 每段英文字母数字 → 短语前缀匹配（如 `health` → `"health" *`）；
 * - 各片段之间为隐式 AND；无任何可检索片段（纯标点 / 空白）返回 null。
 */
export function buildFts5MatchQuery(query: string): string | null {
  const terms: string[] = [];
  for (const match of query.matchAll(CJK_RUN)) {
    terms.push(quoteFts5String(toCjkSpacedText(match[0])));
  }
  for (const match of query.matchAll(ASCII_RUN)) {
    terms.push(`${quoteFts5String(match[0])} *`);
  }
  if (terms.length === 0) return null;
  // FTS5 语法：空格分隔的多个词元为隐式 AND
  return terms.join(' ');
}

/** FTS5 字符串字面量：双引号内出现双引号需翻倍转义 */
function quoteFts5String(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * 摘要检索文本：AI 摘要各段（这是什么 / 影响谁 / 关键条款 / 截止日期 /
 * 如何提意见）的 text 拼接 —— 原文引用（quote）不入索引（PRD：索引字段
 * 含标题、AI 摘要、正文；引用是原文片段，入索引会造成重复命中偏置）。
 * 摘要 JSON 缺失或形状异常时返回空串（此时仅标题 / 正文可命中）。
 */
export function summarySearchText(aiSummary: unknown): string {
  const summary = parseQuotedSummary(aiSummary);
  if (summary === null) return '';
  const sections = [
    summary.what.text,
    summary.who.text,
    ...summary.keyPoints.map((point) => point.text),
    summary.deadline.text ?? '',
    summary.howToComment.text,
  ];
  return sections.filter((text) => text.length > 0).join('\n');
}

/** 库内条目 → 检索文档（索引字段：标题、摘要文本、正文纯文本）。 */
export function buildSearchDocument(notice: NoticeRecord): SearchDocument {
  return {
    id: notice.id,
    title: notice.title,
    summary: summarySearchText(notice.aiSummary),
    body: notice.bodyText ?? '',
  };
}
