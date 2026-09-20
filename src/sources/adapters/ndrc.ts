import * as cheerio from 'cheerio';
import type { NormalizedNotice, ParsedDetail, SourceAdapter } from '../registry.ts';
import { normalizeDateText } from '../../lib/dates.ts';
import {
  agencyFromTitle,
  collectAttachments,
  extractDeadline,
  htmlFragmentText,
  normalizeWhitespace,
  parseJsonObject,
  resolveUrl,
  stripStatusMarker,
  textOf,
} from './extract.ts';

/**
 * 国家发展改革委「意见征求」源适配器（issue #20，PRD M2 的第 8 个源）。
 *
 * ## 为什么本源需要「链式跳转」契约
 *
 * 列表条目链接是前端渲染页 `https://yyglxxbsgw.ndrc.gov.cn/sa.html#/<shortKey>`，
 * 正文要一跳一跳才拿得到（2026-09-20 实测）：
 *
 * 1. 列表 `https://www.ndrc.gov.cn/hdjl/yjzq/`：`ul.u-list > li > a[href][title]`
 *    + `<span>2026/09/04</span>`，标题带 `【进行中】` 前缀 / `[已结束]` 后缀；
 * 2. `GET /public/submission-service/article/access-url?shortKey=<k>`
 *    → `{"status":1,"data":"https://…/htmls/article/article.html?articleId=<uuid>"}`；
 * 3. 该 article.html 只是**空壳**（`<h2></h2>`、`.yjzq-content` 为空，正文由脚本填充），
 *    真正的内容接口是 `GET /public/submission-service/column/getArticleDetail?articleId=<uuid>`
 *    → `{data:{articleTitle, articleContent, publishDate, articleSource, …}}`。
 *
 * 因此本源：`detailContentUrl` 给出第 2 跳地址（同步，由 shortKey 推出），
 * `resolveDetailUrl` 负责第 3 跳（从 access-url 响应的 `data` 里取 articleId，
 * 直接走内容接口）—— **刻意跳过第 3 步的空壳 article.html**，少一次无效请求。
 *
 * ## 关键实现约定：下一跳地址相对「当前跳地址」推导
 *
 * 数据服务域名（yyglxxbsgw.ndrc.gov.cn）与栏目域名（www.ndrc.gov.cn）不同，
 * 且 E2E 必须落在 fixture 目录内（ADR-0001）。做法是**不硬编码域名**：
 * - 第 2 跳 = `new URL('public/submission-service/article/access-url?shortKey=…', notice.url)`
 *   —— 生产落在数据服务域名下，fixture 里落在 `<fixture>/ndrc/<条目目录>/` 下；
 * - 第 3 跳 = 从当前地址里截出 `/public/submission-service/` 服务根再拼 `column/…`
 *   （不能按目录相对解析：`access-url` 无尾斜杠，相对解析会拼成
 *   `/…/article/public/submission-service/column/…`）。
 *
 * ## 已知取舍
 * - **截止日期在正文里**（「此次公开征求意见的时间为 X 至 Y」），由 extractDeadline
 *   的「至/到 + 日期」规则取区间结束日；列表层只有状态标注，没有日期。
 * - 发布机关取标题前缀（「国家发展改革委关于…」→ 国家发展改革委）；接口里的
 *   `articleSource` 是承办司局 / 局（如「国家能源局」「国防司」），**不用作发布机关**。
 * - 附件是正文 HTML 里的绝对链接（`yyglxxbs.ndrc.gov.cn/file-submission/….docx`）。
 * - 接口返回的标题含 `<BR>` 换行标签（实测「《售电公司<BR>管理办法…》」），
 *   入库前剥掉。
 */

/** 列表页：国家发展改革委「意见征求」（真实路径，见文件头）。 */
const LIST_URL = 'https://www.ndrc.gov.cn/hdjl/yjzq/';

/** 数据服务的路径前缀（第 2、3 跳都在它下面，见文件头）。 */
const SUBMISSION_PREFIX = '/public/submission-service/';

/** 栏目主办方兜底（标题取不到机关前缀时，如「关于向社会公开征求对《…》意见的公告」）。 */
const DEFAULT_AGENCY = '国家发展改革委';

/** 从 `sa.html#/<shortKey>` 取 shortKey（hash 形如 `#/sdgsglbf`，可能带查询串）。 */
function shortKeyOf(noticeUrl: string): string | null {
  const hashAt = noticeUrl.indexOf('#');
  if (hashAt < 0) return null;
  const key = noticeUrl.slice(hashAt + 1).replace(/^\//, '').split('?')[0] ?? '';
  return key.trim().length > 0 ? key.trim() : null;
}

/** 从文章页地址取 articleId（形如 `…/article.html?articleId=<uuid>`）。 */
function articleIdOf(articleUrl: string): string | null {
  const match = /[?&]articleId=([0-9a-zA-Z-]+)/.exec(articleUrl);
  return match ? match[1] : null;
}

/**
 * 取数据服务根（当前地址里 `/public/submission-service/` 之前的全部内容）。
 * 取不到时返回 null —— 说明当前地址不是本源构造的，不该继续跳。
 */
function submissionRootOf(pageUrl: string): string | null {
  const at = pageUrl.indexOf(SUBMISSION_PREFIX);
  return at < 0 ? null : pageUrl.slice(0, at + SUBMISSION_PREFIX.length);
}

export const ndrcAdapter: SourceAdapter = {
  id: 'ndrc',
  name: '国家发展改革委·意见征求',
  listUrl: LIST_URL,

  async parseList(html: string, baseUrl: string): Promise<NormalizedNotice[]> {
    const $ = cheerio.load(html);
    const notices: NormalizedNotice[] = [];
    const seen = new Set<string>();

    $('ul.u-list li').each((_, element) => {
      const row = $(element);
      const anchor = row.find('a[href]').first();
      const href = anchor.attr('href') ?? '';
      if (href.length === 0) return; // li.empty 占位行没有链接

      // 标题带状态标注（【进行中】前缀 / [已结束] 后缀），剥离后作权威状态
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
        // 截止日期只在正文接口返回的内容里（列表没有），由链式跳转后的详情补充
        deadlineAt: null,
        status,
        bodyText: null,
        attachments: [],
      });
    });

    return notices;
  },

  /** 第 2 跳：由 shortKey 推出的 access-url 接口（相对条目地址解析，见文件头）。 */
  detailContentUrl(notice: NormalizedNotice): string | null {
    const key = shortKeyOf(notice.url);
    if (!key) return null;
    try {
      return new URL(
        `public/submission-service/article/access-url?shortKey=${encodeURIComponent(key)}`,
        notice.url,
      ).toString();
    } catch {
      return null;
    }
  },

  /**
   * 第 3 跳：access-url 响应的 `data` 是文章页地址，从中取 articleId 直接走内容接口。
   * 内容接口的响应 `data` 是对象 → 返回 null，表示当前 body 即详情内容。
   */
  resolveDetailUrl(body: string, pageUrl: string): string | null {
    const parsed = parseJsonObject(body);
    const data = parsed?.data;
    if (typeof data !== 'string') return null; // 已是内容接口响应（data 为对象）

    const root = submissionRootOf(pageUrl);
    if (!root) return null;
    const articleId = articleIdOf(data);
    if (!articleId) {
      // access-url 响应缺 articleId：报错让抓取层记日志并降级，而不是把接口响应当正文
      throw new Error('access-url 响应缺少 articleId');
    }
    return `${root}column/getArticleDetail?articleId=${articleId}`;
  },

  async parseDetail(payload: string, pageUrl: string): Promise<ParsedDetail | null> {
    const parsed = parseJsonObject(payload);
    const data = parsed?.data;
    if (typeof data !== 'object' || data === null) return null;
    const record = data as Record<string, unknown>;

    // 标题里的 <BR> 是源站换行标签（见文件头取舍）
    const title = normalizeWhitespace(textOf(record.articleTitle).replace(/<br\s*\/?>/gi, ''));
    const publishedAt =
      normalizeDateText(normalizeWhitespace(textOf(record.publishDate)).slice(0, 10)) ?? undefined;

    const contentHtml = textOf(record.articleContent);
    const bodyText = htmlFragmentText(contentHtml);
    const deadlineAt = extractDeadline(bodyText) ?? undefined;
    // 附件在正文 HTML 内（绝对链接）；相对链接按人工页地址解析
    const attachments = collectAttachments(cheerio.load(contentHtml), pageUrl);

    if (!title && !publishedAt && !deadlineAt && !bodyText && attachments.length === 0) {
      return null;
    }
    return { title, publishedAt, deadlineAt, bodyText, attachments };
  },
};
