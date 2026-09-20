import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { NoticeAttachment } from '../../db/types.ts';
import { normalizeDateText } from '../../lib/dates.ts';

/**
 * 政府站点页面抽取工具（issue #14 起三个源适配器共用）。
 *
 * 三源分属不同 CMS（人大网 flcaw 接口 / 司法部 TRS / 生态环境部 TRS），
 * 但「正文纯文本」「附件清单」「截止日期」的抽取口径一致，集中在此避免三份拷贝：
 * 各适配器只负责自己页面的列表与详情容器定位。
 */

/** 折叠空白：政府页面正文大量使用全角空格与换行，统一压成单空格并去首尾。 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 相对链接 → 绝对 URL（只允许 http/https，过滤 javascript:、mailto: 等）。 */
export function resolveUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** 接口字段的安全取值：非字符串（null/数字/缺失）统一成空串。 */
export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 容错 JSON 解析：列表 / 详情接口返回的可能是错误页或 WAF 拦截页（HTML），
 * 此时返回 null 由调用方降级，而不是抛异常中断整轮抓取。
 */
export function parseJsonObject(payload: string): Record<string, unknown> | null {
  const trimmed = payload.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 从接口响应取数组字段（如 rows）；非数组时返回空数组。 */
export function rowsOf(data: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = data[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
  );
}

/**
 * 正文 → 纯文本：按「最内层块级元素」逐块取文本（政府页面正文混用 `<p>` 与
 * `<div>` 两种排版，只取 p 会漏掉整段内容），块间以换行连接；
 * 无块级元素时退化为整块文本。containerSelector 省略时作用于整篇文档。
 */
export function blockText($: CheerioAPI, containerSelector?: string): string | undefined {
  const root = containerSelector ? $(containerSelector).first() : $.root();
  if (root.length === 0) return undefined;

  const blocks: string[] = [];
  root.find('p, div, li, td').each((_, element) => {
    const node = $(element);
    // 只取最内层块：含嵌套块级子元素的容器交给其子元素输出，避免同一段文字重复
    if (node.children('p, div, li, td').length > 0) return;
    const text = normalizeWhitespace(node.text());
    if (text.length > 0) blocks.push(text);
  });
  if (blocks.length > 0) return blocks.join('\n');

  const fallback = normalizeWhitespace(root.text());
  return fallback.length > 0 ? fallback : undefined;
}

/** HTML 片段（如接口返回的正文 HTML）→ 纯文本。 */
export function htmlFragmentText(fragment: string): string | undefined {
  if (normalizeWhitespace(fragment).length === 0) return undefined;
  return blockText(cheerio.load(fragment));
}

/** 附件文件扩展名（草案文本 / 说明通常为 PDF、Word 等）。 */
const ATTACHMENT_PATH = /\.(pdf|docx?|wps|xls[xm]?|zip|rar)$/i;

/**
 * 按扩展名收集附件链接（去重、保序）：名称取链接文本，链接文本为空时退化为文件名。
 * containerSelector 省略时扫描整篇文档。
 */
export function collectAttachments(
  $: CheerioAPI,
  pageUrl: string,
  containerSelector?: string,
): NoticeAttachment[] {
  const root = containerSelector ? $(containerSelector).first() : $.root();
  if (root.length === 0) return [];

  const attachments: NoticeAttachment[] = [];
  const seen = new Set<string>();
  root.find('a[href]').each((_, element) => {
    const anchor = $(element);
    const url = resolveUrl(anchor.attr('href') ?? '', pageUrl);
    if (!url || !ATTACHMENT_PATH.test(new URL(url).pathname)) return;
    if (seen.has(url)) return;
    seen.add(url);
    const name = normalizeWhitespace(anchor.text());
    const fallbackName = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? url);
    attachments.push({ name: name.length > 0 ? name : fallbackName, url });
  });
  return attachments;
}

/** 日期文本（中文 / ISO / 斜杠三种写法，均要求到「日」）。 */
const DATE_TEXT = String.raw`(\d{4}年\d{1,2}月\d{1,2}日|\d{4}-\d{1,2}-\d{1,2}|\d{4}/\d{1,2}/\d{1,2})`;

/**
 * 从正文纯文本中抽取「征求意见截止日期」。
 *
 * 官方通知里截止日期的写法并不统一（实测三源各不相同），按优先级依次匹配：
 * 1. `征求意见截止时间为2026年10月14日` / `截止日期：2026-10-14`（司法部、生态环境部常见）；
 * 2. `征求意见时间为2026年3月20日至2026年4月19日` —— 取区间结束日（司法部最常见写法）；
 * 3. `请于2026年10月14日前反馈` —— 取「于…前」中的日期。
 * 都匹配不到时返回 null（保持字段为空，绝不用列表页日期或抓取日期顶替）。
 */
export function extractDeadline(bodyText: string | undefined): string | null {
  if (!bodyText) return null;
  const text = normalizeWhitespace(bodyText);
  const rules = [
    new RegExp(String.raw`截止(?:日期|时间)?(?:为|：|:)?\s*${DATE_TEXT}`),
    new RegExp(String.raw`(?:至|到)\s*${DATE_TEXT}`),
    new RegExp(String.raw`(?:请|应)?于\s*${DATE_TEXT}\s*(?:前|之前)`),
  ];
  for (const rule of rules) {
    const match = rule.exec(text);
    if (match) {
      const iso = normalizeDateText(match[1]);
      if (iso) return iso;
    }
  }
  return null;
}

/**
 * 从通知标题前缀取发布机关：「司法部、中国人民银行…关于《…》公开征求意见的通知」→ 前缀。
 * 前缀必须含机关字样（部/委/局/院/署/办/厅/政府/人大/银行/监管）才采信，
 * 避免把「公开征求…」一类短语当成机关；取不到时返回 undefined（由适配器兜底常量）。
 *
 * 注意：这里刻意用 indexOf 拆前缀而**不用正则字面量**。Node 直接运行 .ts（类型擦除）
 * 时，本文件里若出现 `/^(.{2,60}?)关于[…]/` 这样的正则字面量，解析器会误判为除号，
 * 在几十行之外报 ERR_INVALID_TYPESCRIPT_SYNTAX（实测踩过，换转义/换字符类都无效）。
 * 改动本函数时请保持无正则字面量的写法。
 */
export function agencyFromTitle(title: string): string | undefined {
  const text = normalizeWhitespace(title);
  const at = text.indexOf('关于');
  // 前缀长度 2~60 字，且「关于」之后紧跟书名号 / 括号（《 〔 （）才视为机关前缀
  if (at < 2 || at > 60) return undefined;
  if (!'《〔（'.includes(text.charAt(at + 2))) return undefined;
  const candidate = text.slice(0, at).trim();
  return /[部委局院署办厅]|政府|人大|银行|监管/.test(candidate) ? candidate : undefined;
}
