import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { NoticeAttachment } from '../../db/types.ts';
import { normalizeDateText } from '../../lib/dates.ts';
import type { NormalizedNotice, ParsedDetail, SourceAdapter } from '../registry.ts';

/**
 * 司法部（中国政府法制信息网）征求意见系统适配器（issue #5，M1 三源之二）。
 *
 * 输入 = 司法部（moj.gov.cn）征求意见栏目列表页 / 详情页 HTML 快照
 * （fixtures/moj/，仿真实页面结构合成）；输出 = 标准化公示条目。
 *
 * 页面结构与全国人大源（npc）明显不同：
 * - 列表页为「卡片 + 表格」混合版式：置顶征求意见为卡片（`div.zqyj-card`），
 *   其余条目为表格行（`table.zqyj-table` 的 `tbody tr`，含发布机关 / 日期 / 状态列）；
 * - 详情页标题用 `h2.art-title`（非 h1），正文在 TRS CMS 的 `.TRS_Editor` 容器，
 *   截止时间在醒目的 `.zqyj-deadline` 提示条，发布时间在 `.art-meta`；
 * - 发布机关取自面包屑最后一级栏目（机关司局频道，如「司法部立法一局」），
 *   详情页正文区不出现「发布机关：」文本行；
 * - 附件集中放在正文之后的 `.appendix` 列表（文末附件区）。
 *
 * 列表层解析标题与发布日期（表格行的「发布机关」列一并解析，卡片区兜底为
 * 司法部）；发布机关（面包屑最后一级）、截止时间、正文、附件在详情页解析，
 * 由抓取管线按字段合并。
 */

/** 附件文件扩展名（草案文本 / 说明通常为 PDF、Word 等）。 */
const ATTACHMENT_PATH = /\.(pdf|docx?|wps|xls|xlsx|zip|rar)$/i;

/** 列表层机关兜底：栏目主办方。 */
const DEFAULT_AGENCY = '司法部';

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

/** 截止时间只接受完整日期（ISO 或中文），避免把无关数字当日期。 */
const DEADLINE_TEXT = /(\d{4}-\d{1,2}-\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日)/;
const PUBLISHED_TEXT = /发布时间[:：]?\s*(\d{4}-\d{1,2}-\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日)/;

export const mojAdapter: SourceAdapter = {
  id: 'moj',
  name: '司法部·立法意见征集',
  listUrl: 'https://www.moj.gov.cn/pub/sfbgw/zqyj/list.html',

  async parseList(html: string, baseUrl: string): Promise<NormalizedNotice[]> {
    const $ = cheerio.load(html);
    const notices: NormalizedNotice[] = [];
    const seen = new Set<string>();

    const push = (href: string, titleText: string, dateText: string, agencyText = ''): void => {
      const title = normalizeWhitespace(titleText);
      if (title.length < 4) return;
      const url = resolveUrl(href, baseUrl);
      if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return;
      const key = url.toString();
      if (seen.has(key)) return;
      seen.add(key);
      const agency = normalizeWhitespace(agencyText);
      notices.push({
        title,
        agency: agency.length > 0 ? agency : DEFAULT_AGENCY,
        url: key,
        publishedAt: normalizeDateText(normalizeWhitespace(dateText)),
        deadlineAt: null,
        bodyText: null,
        attachments: [],
      });
    };

    // 卡片区：置顶 / 重点征求意见
    $('div.zqyj-card').each((_, element) => {
      const card = $(element);
      const anchor = card.find('a[href]').first();
      push(anchor.attr('href') ?? '', anchor.text(), card.find('.zqyj-card-date').text());
    });

    // 表格区：常规列表（含发布机关 / 日期 / 状态列；表头在 thead，不参与解析）
    $('table.zqyj-table tbody tr').each((_, element) => {
      const row = $(element);
      const anchor = row.find('a[href]').first();
      push(
        anchor.attr('href') ?? '',
        anchor.text(),
        row.find('td.zqyj-date').text(),
        row.find('td.zqyj-agency').text(),
      );
    });

    return notices;
  },

  async parseDetail(html: string, pageUrl: string): Promise<ParsedDetail | null> {
    const $ = cheerio.load(html);

    const title = normalizeWhitespace($('h2.art-title').first().text()) || undefined;

    // 发布机关在面包屑最后一级栏目（机关司局频道），如 首页 > 征求意见 > 司法部立法一局
    const crumbTexts = $('.crumbs a')
      .map((_, el) => normalizeWhitespace($(el).text()))
      .get()
      .filter((text) => text.length > 0 && text !== '首页');
    const agency = crumbTexts.length > 0 ? crumbTexts[crumbTexts.length - 1] : undefined;

    const deadlineMatch = DEADLINE_TEXT.exec(normalizeWhitespace($('.zqyj-deadline').first().text()));
    const deadlineAt = deadlineMatch ? (normalizeDateText(deadlineMatch[1]) ?? undefined) : undefined;

    const publishedMatch = PUBLISHED_TEXT.exec(normalizeWhitespace($('.art-meta').first().text()));
    const publishedAt = publishedMatch ? (normalizeDateText(publishedMatch[1]) ?? undefined) : undefined;

    const bodyText = extractBodyText($);
    const attachments = extractAttachments($, pageUrl);

    if (!title && !agency && !deadlineAt && !publishedAt && !bodyText && attachments.length === 0) {
      return null;
    }
    return { title, agency, publishedAt, deadlineAt, bodyText, attachments };
  },
};

/** 正文容器：TRS CMS 版式的 .TRS_Editor，按段落拼接纯文本。 */
function extractBodyText($: CheerioAPI): string | undefined {
  const root = $('.TRS_Editor').first();
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

/** 附件集中在正文之后的 .appendix（文末附件区），按扩展名识别。 */
function extractAttachments($: CheerioAPI, pageUrl: string): NoticeAttachment[] {
  const attachments: NoticeAttachment[] = [];
  const seen = new Set<string>();

  $('.appendix a[href]').each((_, element) => {
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
