import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { NoticeAttachment } from '../../db/types.ts';
import { normalizeDateText } from '../../lib/dates.ts';
import type { NormalizedNotice, ParsedDetail, SourceAdapter } from '../registry.ts';

/**
 * 中国政府网「意见征集」栏目适配器（issue #5，M1 三源之三）。
 *
 * 输入 = 中国政府网（www.gov.cn）意见征集栏目列表页 / 详情页 HTML 快照
 * （fixtures/govcn/，仿真实页面结构合成）；输出 = 标准化公示条目。
 *
 * 页面结构与另外两源明显不同：
 * - 列表页为纯表格版式，每行自带「发布机关」与「意见征集截止日期」列
 *   （转发条目的截止列写「见原文」，解析为 null）；条目由单元格类名定位，
 *   不依赖 URL 形态 —— 本栏目既收录中国政府网自发布页，也直接链接部委站原文；
 * - 详情页标题用 `h1.article-title`，元信息在 `.article-meta`（发布日期 / 来源），
 *   「关联部门」框（`.dept-box`，首个即牵头部门）与「征求意见截止日期」框
 *   （`.deadline-box` 的 `.deadline-value`）为醒目独立区块，
 *   正文在 `.article-body`，附件集中在 `.attachment-list`。
 *
 * 列表层解析标题、发布机关、发布日期与截止日期（本源列表层字段最全）；
 * 详情页用关联部门 / 截止日期框复核覆盖，正文与附件只在详情页解析，
 * 由抓取管线按字段合并。
 */

/** 附件文件扩展名（草案文本 / 说明通常为 PDF、Word 等）。 */
const ATTACHMENT_PATH = /\.(pdf|docx?|wps|xls|xlsx|zip|rar)$/i;

/** 列表层机关兜底：栏目主办方（fixture 列表各行的发布机关列均有值）。 */
const DEFAULT_AGENCY = '中国政府网';

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function resolveUrl(href: string, base: string): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

export const govcnAdapter: SourceAdapter = {
  id: 'govcn',
  name: '中国政府网·意见征集',
  listUrl: 'https://www.gov.cn/zhengce/yjzj/list.htm',

  async parseList(html: string, baseUrl: string): Promise<NormalizedNotice[]> {
    const $ = cheerio.load(html);
    const notices: NormalizedNotice[] = [];
    const seen = new Set<string>();

    // 表格行按单元格类名取列；表头在 thead、分页 / 导航在表格之外，均不参与解析
    $('table.yjzj-list tbody tr').each((_, element) => {
      const row = $(element);
      const anchor = row.find('td.zc-title a[href]').first();
      const title = normalizeWhitespace(anchor.text());
      if (title.length < 4) return;

      const url = resolveUrl(anchor.attr('href') ?? '', baseUrl);
      if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return;
      const key = url.toString();
      if (seen.has(key)) return;
      seen.add(key);

      const agency = normalizeWhitespace(row.find('td.zc-agency').text());
      notices.push({
        title,
        agency: agency.length > 0 ? agency : DEFAULT_AGENCY,
        url: key,
        publishedAt: normalizeDateText(normalizeWhitespace(row.find('td.zc-date').text())),
        deadlineAt: normalizeDateText(normalizeWhitespace(row.find('td.zc-deadline').text())),
        bodyText: null,
        attachments: [],
      });
    });

    return notices;
  },

  async parseDetail(html: string, pageUrl: string): Promise<ParsedDetail | null> {
    const $ = cheerio.load(html);

    const title = normalizeWhitespace($('h1.article-title').first().text()) || undefined;
    // 关联部门框：首个为牵头部门
    const agency = normalizeWhitespace($('.dept-box .dept-item').first().text()) || undefined;

    const publishedAt =
      normalizeDateText(normalizeWhitespace($('.article-meta .pub-date').first().text())) ??
      undefined;
    const deadlineText = normalizeWhitespace($('.deadline-box .deadline-value').first().text());
    const deadlineAt = deadlineText.length > 0 ? (normalizeDateText(deadlineText) ?? undefined) : undefined;

    const bodyText = extractBodyText($);
    const attachments = extractAttachments($, pageUrl);

    if (!title && !agency && !deadlineAt && !publishedAt && !bodyText && attachments.length === 0) {
      return null;
    }
    return { title, agency, publishedAt, deadlineAt, bodyText, attachments };
  },
};

/** 正文容器：.article-body 按段落拼接纯文本（无段落时退化为整块文本）。 */
function extractBodyText($: CheerioAPI): string | undefined {
  const root = $('.article-body').first();
  if (root.length === 0) return undefined;

  const paragraphs = root
    .find('p')
    .map((_, el) => normalizeWhitespace($(el).text()))
    .get()
    .filter((text) => text.length > 0);
  if (paragraphs.length > 0) return paragraphs.join('\n');

  const text = normalizeWhitespace(root.text());
  return text.length > 0 ? text : undefined;
}

/** 附件集中在正文之后的 .attachment-list，按扩展名识别。 */
function extractAttachments($: CheerioAPI, pageUrl: string): NoticeAttachment[] {
  const attachments: NoticeAttachment[] = [];
  const seen = new Set<string>();

  $('.attachment-list a[href]').each((_, element) => {
    const anchor = $(element);
    const url = resolveUrl(anchor.attr('href') ?? '', pageUrl);
    if (!url || !ATTACHMENT_PATH.test(url.pathname)) return;
    const key = url.toString();
    if (seen.has(key)) return;
    seen.add(key);

    const name = normalizeWhitespace(anchor.text());
    const fallbackName = decodeURIComponent(url.pathname.split('/').pop() ?? key);
    attachments.push({ name: name.length > 0 ? name : fallbackName, url: key });
  });

  return attachments;
}
