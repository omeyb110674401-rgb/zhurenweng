import * as cheerio from 'cheerio';
import type { NormalizedNotice, ParsedDetail, SourceAdapter } from '../registry.ts';
import { normalizeDateText } from '../../lib/dates.ts';
import {
  agencyFromTitle,
  blockText,
  collectAttachments,
  extractDeadline,
  firstContentSelector,
  normalizeWhitespace,
  resolveUrl,
  stripStatusMarker,
} from './extract.ts';

/**
 * 交通运输部「意见征集」源适配器（issue #18 M2 扩源）。
 *
 * ## 真实站点结构（2026-09-20 本机实测）
 *
 * - 栏目 `https://www.mot.gov.cn/hudong/yijianzhengji/index.html`（互动 → 意见征集）
 *   是**静态 HTML 列表**（无需接口、无需 cookie 握手）：
 *   `<ul class="news-list"><li class="news-item">`
 *     `<a class="news-link" href="…">`
 *       `<span class="news-title"><span class="statusX">[进行中]</span> - 标题</span>`
 *       `<span class="news-date">2026-09-09</span>`
 *     `</a></li>`
 * - **状态标注是本源的真实列表判据**：每条真正的征求意见条目都带
 *   `[进行中]` / `[已结束]`，状态位为空的是栏目里混入的两类非征求意见内容 ——
 *   「…答记者问」（新华网转载的新闻稿）与「…公开征求意见反馈情况」（结果反馈）。
 *   适配器据此过滤（实测依据：本部 10 条里状态为空的正是「反馈情况」一条）。
 * - 状态标注同时是**权威状态来源**（源自己说进行中 / 已结束），交给抓取管线在
 *   截止日期解析不到时采用（见 registry 的 NormalizedNotice.status）。
 * - 条目链接**跨域混排**：本部 `./202609/t….html`、民航局
 *   `https://www.caac.gov.cn/HDJL/YJZJ/…`、国家铁路局 `https://www.nra.gov.cn/…`。
 *   跨域条目的详情页不属于本源模板，正文容器按候选列表**逐个探测**
 *   （见 DETAIL_CONTENT_SELECTORS），三站模板都能取到正文、截止日期与附件；
 *   将来出现第四种模板时，条目仍以「标题 + 机关（标题前缀）+ 发布日期 + 状态 +
 *   官方链接」入库，不整条丢弃。
 * - 详情页（本部条目）：`h1.article-title` 标题、`.article-meta .publish-date`
 *   「2026-09-07 17:00」、正文 `#article-content`；截止句写法
 *   「意见反馈截止日期为2026年10月7日」，附件（.docx / .wps）在正文容器内。
 *
 * ## 已知取舍
 * - 发布日期取列表 `span.news-date`（列表值即发布日；详情 `.publish-date` 含时分，
 *   解析出的日期与列表一致）。
 * - 发布机关取标题前缀；「关于《…》公开征求意见的通知」一类无前缀的标题兜底为
 *   「交通运输部」。`来源: 法制司` 是承办司局，不用作发布机关。
 */

/** 列表页：交通运输部「意见征集」（静态 HTML，见文件头）。 */
const LIST_URL = 'https://www.mot.gov.cn/hudong/yijianzhengji/index.html';

/** 栏目主办方兜底（标题取不到机关前缀时，如「关于《…》公开征求意见的通知」）。 */
const DEFAULT_AGENCY = '交通运输部';

/**
 * 详情页正文容器候选（按序探测，取第一个有正文的）：
 * - `#article-content`：交通运输部本站模板；
 * - `#Zoom`：国家铁路局（www.nra.gov.cn）；
 * - `div.content`：中国民用航空局（www.caac.gov.cn，正文与附件都在这一个容器里）。
 *
 * 列表条目跨域混排，三个站点模板各不相同。**按内容探测而非按 host 分派**：
 * E2E fixture 源站的 host 是本地地址，按 host 分派会让快照与生产走两条不同代码路径
 * （理由见 extract.ts 的 firstContentSelector）。全部探测不到时条目仍以
 * 「标题 + 机关 + 发布日期 + 状态 + 官方链接」入库，不整条丢弃。
 */
const DETAIL_CONTENT_SELECTORS = ['#article-content', '#Zoom', 'div.content'] as const;

export const motAdapter: SourceAdapter = {
  id: 'mot',
  name: '交通运输部·意见征集',
  listUrl: LIST_URL,

  async parseList(html: string, baseUrl: string): Promise<NormalizedNotice[]> {
    const $ = cheerio.load(html);
    const notices: NormalizedNotice[] = [];
    const seen = new Set<string>();

    $('ul.news-list li.news-item').each((_, element) => {
      const row = $(element);
      const anchor = row.find('a.news-link[href]').first();
      const href = anchor.attr('href') ?? '';
      if (href.length === 0) return;

      // 状态标注：空标注的是栏目里混入的新闻稿（答记者问），不是征求意见条目
      const { status, text: title } = stripStatusMarker(anchor.find('.news-title').first().text());
      if (status === undefined) return;
      if (title.length < 4) return;

      const url = resolveUrl(href, baseUrl);
      if (!url || seen.has(url)) return;
      seen.add(url);

      notices.push({
        title,
        agency: agencyFromTitle(title) ?? DEFAULT_AGENCY,
        url,
        publishedAt: normalizeDateText(normalizeWhitespace(anchor.find('.news-date').first().text())),
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

    const title = normalizeWhitespace($('h1.article-title').first().text()) || undefined;
    const publishedAt =
      normalizeDateText(
        normalizeWhitespace($('.article-meta .publish-date').first().text()).slice(0, 10),
      ) ?? undefined;

    // 正文容器按内容探测（本站 / 民航局 / 铁路局模板不同）；正文与附件取同一容器
    const container = firstContentSelector($, DETAIL_CONTENT_SELECTORS);
    const bodyText = container ? blockText($, container) : undefined;
    const deadlineAt = extractDeadline(bodyText) ?? undefined;
    const attachments = container ? collectAttachments($, pageUrl, container) : [];

    if (!title && !publishedAt && !deadlineAt && !bodyText && attachments.length === 0) {
      return null;
    }
    return { title, publishedAt, deadlineAt, bodyText, attachments };
  },
};
