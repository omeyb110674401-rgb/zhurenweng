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
} from './extract.ts';

/**
 * 司法部「立法意见征集」源适配器（issue #5 接入；issue #14 对着活站重写）。
 *
 * ## 真实站点结构（2026-09-20 在服务器实测）
 *
 * - 真实栏目是「立法意见征集」（不是早期猜测的 /pub/sfbgw/zqyj/）：
 *     https://www.moj.gov.cn/pub/sfbgw/lfyjzj/lflfyjzj/
 *   入口来自首页导航「立法意见征集」→ ./lfyjzj/lflfyjzj/。
 * - 列表为单列时间轴（不是表格）：`ul.newsMsgList_zzy > li`，每条
 *   `<div class="rightData">2026-03-20</div>` + `<a class="leftA" href="…">标题</a>`；
 *   列表标题在页面里被截断（带省略号），完整标题只有详情页有 —— 详情解析出的
 *   标题会覆盖列表标题（抓取管线的 mergeDetail 按字段合并）。
 * - 详情页：`h1` 是标题（不是 h2.art-title）、`.sT` 内含「发布时间：YYYY-MM-DD HH:MM」、
 *   正文在 `.news_content_style > .TRS_Editor`（内含嵌套 TRS_Editor 与 style 块）、
 *   附件区为 `#isShowFile.appendix_file`（多数通知没有附件，只有「附件：」标题行）。
 * - **截止日期不在独立区块里**，只在正文句中：实测写法为
 *   「征求意见时间为2026年3月20日至2026年4月19日。」（区间结束日即截止日），
 *   少数写作「截止时间为…」。故截止日期从正文纯文本抽取（extractDeadline）。
 * - 发布机关：详情页没有「发布机关：」行，面包屑最后一级是栏目名（立法意见征集）
 *   而不是机关 → 机关取自标题前缀（「司法部、中国人民银行…关于《…》的通知」→
 *   该前缀），取不到时兜底「司法部」。
 *
 * ## 抓取处置：WAF cookie 挑战（issue #14）
 *
 * 该站 openresty WAF 对首次请求返回 302 + Set-Cookie（CT6T / CT6TS），且 Location
 * 指回同一地址；**必须带这组 cookie 重放一次**才返回 200 —— 不带 cookie 时 fetch
 * 的自动重定向会陷入自我循环（表现为 fetch failed）。因此本源声明
 * `fetch: { cookieChallenge: true }`（抓取层实现，仅对本源生效）。
 * 实测爬虫 UA 在握手之后可用，无需伪装浏览器 UA。
 */

/** 列表页：司法部「立法意见征集」栏目（真实路径，见文件头实测依据）。 */
const LIST_URL = 'https://www.moj.gov.cn/pub/sfbgw/lfyjzj/lflfyjzj/';

/** 列表标题被截断 / 取不到机关前缀时的兜底机关（栏目主办方）。 */
const DEFAULT_AGENCY = '司法部';

/** 发布时间：「发布时间：2026-03-20 17:00」 */
const PUBLISHED_TEXT = /发布时间[:：]?\s*(\d{4}-\d{1,2}-\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日)/;

export const mojAdapter: SourceAdapter = {
  id: 'moj',
  name: '司法部·立法意见征集',
  listUrl: LIST_URL,
  /** WAF cookie 挑战：首个 3xx + Set-Cookie 必须带 cookie 重放（见文件头） */
  fetch: { cookieChallenge: true },

  async parseList(html: string, baseUrl: string): Promise<NormalizedNotice[]> {
    const $ = cheerio.load(html);
    const notices: NormalizedNotice[] = [];
    const seen = new Set<string>();

    // 列表项：ul.newsMsgList_zzy 下的 li（页面里导航 / 侧栏也是 li，
    // 这里要求「有链接且带 .rightData 日期」，与真实列表项结构一致）
    $('ul.newsMsgList_zzy li').each((_, element) => {
      const row = $(element);
      const anchor = row.find('a[href]').first();
      const href = anchor.attr('href') ?? '';
      const title = normalizeWhitespace(anchor.text());
      const dateText = normalizeWhitespace(row.find('.rightData').first().text());
      if (title.length < 4 || href.length === 0) return;

      const url = resolveUrl(href, baseUrl);
      if (!url || seen.has(url)) return;
      seen.add(url);

      notices.push({
        title,
        agency: agencyFromTitle(title) ?? DEFAULT_AGENCY,
        url,
        publishedAt: normalizeDateText(dateText),
        // 截止日期只在详情页正文里（见文件头），列表层留空、由详情补充
        deadlineAt: null,
        bodyText: null,
        attachments: [],
      });
    });

    return notices;
  },

  async parseDetail(html: string, pageUrl: string): Promise<ParsedDetail | null> {
    const $ = cheerio.load(html);

    // 详情页 h1 才是完整标题（列表标题被截断）
    const title = normalizeWhitespace($('h1').first().text()) || undefined;

    const publishedMatch = PUBLISHED_TEXT.exec(normalizeWhitespace($('.sT').first().text()));
    const publishedAt = publishedMatch
      ? (normalizeDateText(publishedMatch[1]) ?? undefined)
      : undefined;

    const bodyText =
      blockText($, '.news_content_style .TRS_Editor') ?? blockText($, '.news_content_style');
    const deadlineAt = extractDeadline(bodyText) ?? undefined;
    // 附件集中在正文之后的附件区（#isShowFile.appendix_file），按扩展名识别
    const attachments = collectAttachments($, pageUrl, '#isShowFile');
    // 机关取自标题前缀（详情页无「发布机关：」行、面包屑是栏目名）
    const agency = agencyFromTitle(title ?? '') ?? undefined;

    if (!title && !agency && !publishedAt && !deadlineAt && !bodyText && attachments.length === 0) {
      return null;
    }
    return { title, agency, publishedAt, deadlineAt, bodyText, attachments };
  },
};
