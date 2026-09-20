import * as cheerio from 'cheerio';
import type { NormalizedNotice, ParsedDetail, SourceAdapter } from '../registry.ts';
import { normalizeDateText } from '../../lib/dates.ts';
import {
  agencyFromTitle,
  blockText,
  collectAttachments,
  extractDeadline,
  normalizeWhitespace,
  resolveUrl,
  stripStatusMarker,
} from './extract.ts';

/**
 * 教育部「征求意见」源适配器（issue #18 M2 扩源）。
 *
 * ## 真实站点结构（2026-09-20 本机实测）
 *
 * - 栏目 `http://www.moe.gov.cn/jyb_xwfb/s248/`（首页导航「征求意见」的唯一入口，
 *   实测首页「征求意见」链接即指向本栏目）是**静态 HTML 列表**：
 *   `<div id="list"><li><a href="./202402/t….html" title="[已结束]教育部关于《…》…">…</a>`
 *   `<span>2024-02-08</span></li>…`
 * - **标题必须取 `title` 属性**：列表里联合发布的条目链接文本被截断（带 `...`），
 *   `title` 属性是完整标题（实测「人力资源社会保障部办公厅 教育部办公厅关于…」一条）。
 * - 状态标注 `[已结束]` / `[进行中]` 在标题前缀里，剥离后作为权威状态入库
 *   （见 registry 的 NormalizedNotice.status）。
 * - 详情页：`.moe-detail-box h1` 是干净标题（不带状态标注）、
 *   `.moe-detail-shuxing` 首段是「2024-02-08 来源：教育部」、
 *   正文容器 `.moe-detail-box .TRS_Editor`（注意页面尾部的 `#detail-editor`
 *   只是「（责任编辑：…）」一行，**不是**正文容器）。
 *   截止句写法「本次征求意见截止日期为2024年3月8日」；附件（.docx）为
 *   `./W020….docx` 相对链接，相对详情页地址解析。
 *
 * ## 已知取舍：本栏目自 2024-02 起未再更新（实测最新一条 2024-02-08）
 *
 * 教育部已把新征求意见稿改由其它渠道发布，本栏目当前是**历史归档**（52 条，全部已截止）。
 * 仍然接入的理由：① 产品定位含「按主题搜索历史公示」，教育领域的征求意见稿
 * （教师法修订草案、学位法草案、学前教育法草案、校外培训管理条例等）是重要的公共参与史料；
 * ② 栏目一旦恢复更新，适配器无需改动即可自动跟进。
 * 代价：每轮抓取会为这 52 条历史条目重复抓取详情页（礼貌间隔 400ms ≈ 21s/轮）。
 * 若后续要省掉这部分开销，应做的是「已入库且正文非空的条目跳过详情重抓」这一通用优化，
 * 而不是给单个源开后门。
 */

/** 列表页：教育部「征求意见」（静态 HTML，见文件头）。 */
const LIST_URL = 'http://www.moe.gov.cn/jyb_xwfb/s248/';

/** 栏目主办方兜底（标题取不到机关前缀时）。 */
const DEFAULT_AGENCY = '教育部';

/** 正文容器（见文件头：不要用 #detail-editor）。 */
const BODY_SELECTOR = '.moe-detail-box .TRS_Editor';

export const moeAdapter: SourceAdapter = {
  id: 'moe',
  name: '教育部·征求意见',
  listUrl: LIST_URL,

  async parseList(html: string, baseUrl: string): Promise<NormalizedNotice[]> {
    const $ = cheerio.load(html);
    const notices: NormalizedNotice[] = [];
    const seen = new Set<string>();

    $('#list li').each((_, element) => {
      const row = $(element);
      const anchor = row.find('a[href]').first();
      const href = anchor.attr('href') ?? '';
      if (href.length === 0) return;

      // 标题优先取 title 属性：链接文本可能被截断（见文件头）
      const raw = normalizeWhitespace(anchor.attr('title') ?? '') || normalizeWhitespace(anchor.text());
      const { status, text: title } = stripStatusMarker(raw);
      if (title.length < 4) return;

      const url = resolveUrl(href, baseUrl);
      if (!url || seen.has(url)) return;
      seen.add(url);

      notices.push({
        title,
        agency: agencyFromTitle(title) ?? DEFAULT_AGENCY,
        url,
        publishedAt: normalizeDateText(normalizeWhitespace(row.find('span').first().text())),
        // 截止日期只在详情页正文（列表没有），由详情补充
        deadlineAt: null,
        status,
        bodyText: null,
        attachments: [],
      });
    });

    return notices;
  },

  async parseDetail(html: string, pageUrl: string): Promise<ParsedDetail | null> {
    const $ = cheerio.load(html);

    // 详情 h1 是干净的完整标题（列表标题带 [已结束] 标注，已在 parseList 剥离）
    const title = normalizeWhitespace($('.moe-detail-box h1').first().text()) || undefined;
    const publishedAt =
      normalizeDateText(
        normalizeWhitespace($('.moe-detail-shuxing').first().text()).slice(0, 10),
      ) ?? undefined;

    const bodyText = blockText($, BODY_SELECTOR);
    const deadlineAt = extractDeadline(bodyText) ?? undefined;
    const attachments = collectAttachments($, pageUrl, BODY_SELECTOR);

    if (!title && !publishedAt && !deadlineAt && !bodyText && attachments.length === 0) {
      return null;
    }
    return { title, publishedAt, deadlineAt, bodyText, attachments };
  },
};
