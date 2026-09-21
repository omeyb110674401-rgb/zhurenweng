import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { NoticeAttachment } from '../../db/types.ts';
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
 * 国家互联网信息办公室（国家网信办）「网信@你」源适配器（issue #29，第 10 个源）。
 *
 * ## 真实站点结构（2026-09-21 本机实测）
 *
 * - 入口**不在首页导航**里：导航只有「时政要闻 / 网信政务 / 互动服务 / 热点专题」，
 *   征求意见条目挂在「互动服务 → 网信@你」（`/hdfw/wxan/A093802index_1.htm`）；
 *   首页那一栏是同一栏目的 3 条切片，栏目页才是全量。
 *   这正是本源早先被误判为「不可接入」的原因（当时按首页导航 + 常见路径探测，
 *   候选路径全 404，结论写成「首页无征求意见入口」）——**栏目藏在互动服务里**。
 *   栏目实测**单页 20 条**（`…index_2.htm` 返回 404，没有第二页），覆盖最近约 9 个月。
 * - 列表页是**服务端渲染的静态 HTML**（TRS 系 CMS，非 jpaas 接口）：
 *   `<div id="loadingInfoPage"><li><h5><a href=… title="完整标题">…</a></h5>`
 *   `<div class="times">2026-09-18</div></li>…`。标题取 `title` 属性（链接文本可能被截断）。
 * - 列表**没有**状态标注、也**没有**截止日期（首页切片里的 `[进行中]` 不在栏目页），
 *   两者都只能从详情页正文取。
 * - 详情页：`h1.title` 是完整标题、`#pubtime` 形如「2026年09月18日 17:00」（带时分，
 *   normalizeDateText 从串中取日期）、正文容器 `#BodyLabel`（在 `.main-content` 内；
 *   正文尾部内联一段 `pagestat` 上报脚本，由 blockText 在克隆体上剔除）。
 * - 截止句实测三种写法：「意见反馈截止日期为2026年10月17日」「意见反馈截止时间为2026年5月3日」
 *   （命中 extractDeadline 规则 1）、「请于2026年8月25日前将意见反馈给组织起草部门」（规则 3）。
 * - 附件是**无扩展名的下载接口**：
 *   `/cms/pub/interact/downloadfile.jsp?filepath=<不透明串>&fText=<文件名>` ——
 *   实测返回 `Content-Disposition: attachment; filename*=UTF-8''…管理要求.pdf`（确为文件），
 *   但通用 collectAttachments 按扩展名判断会全部漏掉，故本源自带 downloadAttachments（见下）。
 *
 * ## 栏目里只有一部分是「征求意见」（实测 20 条里 8 条）
 *
 * 该栏目性质是**通知公告**，混排了换届征集委员、公开招聘、结果公示、问卷调查等非征求意见条目
 * （「关于全国网络安全标准化技术委员会换届及征集委员的通知」「中国网络空间安全协会2026年公开招聘公告」…）。
 * 全量入库等于把招聘公告塞进征求意见聚合站，直接伤害产品定位，故 parseList 按标题过滤
 * `征求…意见`：实测选中 8/20，且不误伤「关于公开征求《消费类网联摄像头网络安全标识实施规则》
 * 及相关标准意见的通知」这种书名号夹在中间、没有「征求意见」四连字的写法。
 *
 * ## 已知取舍
 *
 * - 只抓栏目第 1 页（20 条 ≈ 9 个月）：站点没有第 2 页可抓，更早的历史条目只能靠其它源。
 * - 标题取不到机关前缀时兜底「国家互联网信息办公室」：实测 8 条里 7 条标题自带机关名；
 *   例外一条（强制性国家标准《政务移动互联网应用程序管理要求》）正文落款是
 *   「中央网络安全和信息化委员会办公室」——与国家网信办是**一个机构两块牌子**，
 *   兜底值不构成事实错误，因此不为它加一套正文落款识别（避免误伤其它源的机关字段）。
 */

/** 栏目页：互动服务 → 网信@你（见文件头）。 */
const LIST_URL = 'https://www.cac.gov.cn/hdfw/wxan/A093802index_1.htm';

/** 栏目主办方兜底（标题取不到机关前缀时，见文件头）。 */
const DEFAULT_AGENCY = '国家互联网信息办公室';

/** 正文容器（见文件头：正文尾部内联脚本由 blockText 剔除）。 */
const BODY_SELECTOR = '#BodyLabel';

/** 无扩展名的附件下载接口（见文件头）。 */
const DOWNLOAD_PATH = '/cms/pub/interact/downloadfile.jsp';

/**
 * 「是不是征求意见条目」的判据（见文件头实测）：`征求` 与 `意见` 之间允许夹书名号
 * 或其它修饰，但不超过 60 字 —— 再长就不是同一个标题里的征求短语了。
 */
const COMMENT_TITLE = /征求[\s\S]{0,60}?意见/;

/**
 * 附件收集（本源专用）：下载接口链接无扩展名，通用 collectAttachments 认不出来。
 * 文件名取查询参数 `fText`（实测是中文全名，如「政务移动互联网应用程序管理要求（征求意见稿）」），
 * 缺失时退回链接文本；再用通用收集器兜底直接指向 `.pdf` / `.docx` 的链接，按 URL 去重。
 */
function downloadAttachments($: CheerioAPI, pageUrl: string): NoticeAttachment[] {
  const attachments: NoticeAttachment[] = [];
  const seen = new Set<string>();

  $(`${BODY_SELECTOR} a[href]`).each((_, element) => {
    const anchor = $(element);
    const url = resolveUrl(anchor.attr('href') ?? '', pageUrl);
    if (!url || seen.has(url)) return;

    let name = '';
    try {
      const parsed = new URL(url);
      if (!parsed.pathname.endsWith(DOWNLOAD_PATH)) return;
      name = normalizeWhitespace(parsed.searchParams.get('fText') ?? '');
    } catch {
      return;
    }
    seen.add(url);
    attachments.push({
      name: name.length > 0 ? name : normalizeWhitespace(anchor.text()),
      url,
    });
  });

  for (const attachment of collectAttachments($, pageUrl, BODY_SELECTOR)) {
    if (seen.has(attachment.url)) continue;
    seen.add(attachment.url);
    attachments.push(attachment);
  }
  return attachments;
}

export const cacAdapter: SourceAdapter = {
  id: 'cac',
  name: '国家网信办·网信@你',

  listUrl: LIST_URL,

  async parseList(html: string, baseUrl: string): Promise<NormalizedNotice[]> {
    const $ = cheerio.load(html);
    const notices: NormalizedNotice[] = [];
    const seen = new Set<string>();

    $('#loadingInfoPage li').each((_, element) => {
      const row = $(element);
      const anchor = row.find('a[href]').first();
      const href = anchor.attr('href') ?? '';
      if (href.length === 0) return;

      // 标题优先取 title 属性：链接文本可能被截断（与 moe 同因）
      const raw =
        normalizeWhitespace(anchor.attr('title') ?? '') || normalizeWhitespace(anchor.text());
      // 栏目页没有状态标注，但首页切片有 —— 站点若把它搬到栏目页，这里自动跟上
      const { status, text: title } = stripStatusMarker(raw);
      // 栏目混排通知公告，只留征求意见条目（见文件头实测）
      if (title.length < 4 || !COMMENT_TITLE.test(title)) return;

      const url = resolveUrl(href, baseUrl);
      if (!url || seen.has(url)) return;
      seen.add(url);

      notices.push({
        title,
        agency: agencyFromTitle(title) ?? DEFAULT_AGENCY,
        url,
        publishedAt: normalizeDateText(normalizeWhitespace(row.find('.times').first().text())),
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

    const title = normalizeWhitespace($('.main-title h1.title').first().text()) || undefined;
    const publishedAt =
      normalizeDateText(normalizeWhitespace($('#pubtime').first().text())) ?? undefined;
    const bodyText = blockText($, BODY_SELECTOR);
    const deadlineAt = extractDeadline(bodyText) ?? undefined;
    const attachments = downloadAttachments($, pageUrl);

    if (!title && !publishedAt && !deadlineAt && !bodyText && attachments.length === 0) {
      return null;
    }
    return { title, publishedAt, deadlineAt, bodyText, attachments };
  },
};
