import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { NoticeAttachment } from '../../db/types.ts';
import { normalizeDateText } from '../../lib/dates.ts';
import type { NormalizedNotice, ParsedDetail, SourceAdapter } from '../registry.ts';

/**
 * 全国人大网「法律草案征求意见」源适配器（issue #3，M1 三源之一）。
 *
 * 输入 = 中国人大网（npc.gov.cn）列表页 / 详情页 HTML 快照
 * （fixtures/npc/，仿真实页面结构）；输出 = 标准化公示条目。
 *
 * 页面结构（基于 npc.gov.cn 实际版式合成）：
 * - 列表页：条目为 `<li><a href="…/c30834/tYYYYMMDD_ID.html">标题</a><span>发布日期</span></li>`；
 * - 详情页：`h1` 标题、`发布机关：` 与 `征求意见截止日期：` 文本行、
 *   `#UCAP-CONTENT` 正文容器、附件为带文件扩展名的 `<a href>`。
 *
 * 列表页只有标题与发布日期；截止日期、正文纯文本、附件清单在详情页解析，
 * 由抓取管线按字段合并。
 */

/** 法律草案征求意见栏目下条目详情页的 URL 形态（用于在列表页噪声链接中筛选条目）。 */
const NOTICE_DETAIL_PATH = /\/c30834\/t\d+_\d+\.s?html?$/i;

/** 附件文件扩展名（官方草案文本 / 说明通常为 PDF、Word 等）。 */
const ATTACHMENT_PATH = /\.(pdf|docx?|wps|xls|xlsx|zip|rar)$/i;

/** 该栏目条目的默认发布机关（详情页缺失发布机关行时的兜底）。 */
const DEFAULT_AGENCY = '全国人大常委会法制工作委员会';

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

export const npcLawDraftsAdapter: SourceAdapter = {
  id: 'npc',
  name: '全国人大网·法律草案征求意见',
  listUrl: 'https://www.npc.gov.cn/npc/c2/c30834/list.shtml',

  async parseList(html: string, baseUrl: string): Promise<NormalizedNotice[]> {
    const $ = cheerio.load(html);
    const notices: NormalizedNotice[] = [];
    const seen = new Set<string>();

    $('li').each((_, element) => {
      const item = $(element);
      const anchor = item.find('a[href]').first();
      const title = normalizeWhitespace(anchor.text());
      const href = anchor.attr('href') ?? '';
      if (title.length < 4) return;

      const url = resolveUrl(href, baseUrl);
      if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return;
      // 只收录本栏目条目详情页链接，过滤面包屑 / 分页 / 导航等噪声
      if (!NOTICE_DETAIL_PATH.test(url.pathname)) return;
      const key = url.toString();
      if (seen.has(key)) return;
      seen.add(key);

      const publishedAt = normalizeDateText(normalizeWhitespace(item.text()));
      notices.push({
        title,
        agency: DEFAULT_AGENCY,
        url: key,
        publishedAt,
        deadlineAt: null,
        bodyText: null,
        attachments: [],
      });
    });

    return notices;
  },

  async parseDetail(html: string, pageUrl: string): Promise<ParsedDetail | null> {
    const $ = cheerio.load(html);
    const pageText = normalizeWhitespace($('body').text());

    const title = normalizeWhitespace($('h1').first().text()) || undefined;
    const agency = /发布机关[:：]\s*(\S+)/.exec(pageText)?.[1];
    const deadlineMatch =
      /(?:征求意见)?截止(?:日期|时间)?[:：为]?\s*(\d{4}年\d{1,2}月\d{1,2}日|\d{4}-\d{1,2}-\d{1,2})/.exec(
        pageText,
      );
    const deadlineAt = deadlineMatch ? (normalizeDateText(deadlineMatch[1]) ?? undefined) : undefined;
    const bodyText = extractBodyText($);
    const attachments = extractAttachments($, pageUrl);

    if (!title && !agency && !deadlineAt && !bodyText && attachments.length === 0) return null;
    return { title, agency, deadlineAt, bodyText, attachments };
  },
};

/** 正文容器按常见政府 CMS 选择器依次探测（fixture 使用 #UCAP-CONTENT）。 */
function extractBodyText($: CheerioAPI): string | undefined {
  const container = $('#UCAP-CONTENT').first();
  const root = container.length > 0 ? container : $('.detail-content').first();
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

function extractAttachments($: CheerioAPI, pageUrl: string): NoticeAttachment[] {
  const attachments: NoticeAttachment[] = [];
  const seen = new Set<string>();

  $('a[href]').each((_, element) => {
    const anchor = $(element);
    const href = anchor.attr('href') ?? '';
    const url = resolveUrl(href, pageUrl);
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
