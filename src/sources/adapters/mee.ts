import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { NormalizedNotice, ParsedDetail, SourceAdapter } from '../registry.ts';
import { normalizeDateText } from '../../lib/dates.ts';
import {
  blockText,
  collectAttachments,
  extractDeadline,
  normalizeWhitespace,
  resolveUrl,
} from './extract.ts';

/**
 * 生态环境部「意见征集」源适配器（issue #14 新增，替代下线的中国政府网「意见征集」栏目）。
 *
 * ## 为什么是生态环境部（选源依据，2026-09-20 服务器实测）
 *
 * 原第三源 `govcn` 指向中国政府网「政策 → 意见征集」栏目，实测该栏目**已下线**：
 * `/zhengce/yjzj/{,list.htm,index.htm,index.html,list.shtml}` 全部 404，政策频道
 * （/zhengce/）现仅剩「最新政策 / 国务院公报 / 政策解读 / 图解政策」四个子栏目，
 * 首页与政策频道导航均无「意见征集」入口；政策文件库路径（/zhengce/zhengceku/、
 * /zhengce/wenjian/、/zhengce/content/）对爬虫一律 403（WAF），不可抓取。
 * 本产品承诺「聚合征求意见稿 + 截止提醒」，因此第三源换成真实、在运营、可抓取
 * 且确含截止日期的部委征求意见栏目：
 *     https://www.mee.gov.cn/hdjl/yjzj/   （生态环境部 · 互动交流 · 意见征集）
 * 实测：HTTP 200；爬虫 UA 直接可用（无需 cookie 握手）；列表带发布日期；
 * 详情正文含「征求意见截止时间为…」/「请于…前…反馈」，截止日期可解析。
 *
 * ## 真实站点结构（实测）
 *
 * - 列表页：`<li><a href="…">标题</a><span class="date">2026-09-14</span></li>`。
 *   条目链接**混用两种相对路径**：栏目内页 `./zjyj/202609/t…shtml` 与
 *   政府信息公开页 `../../xxgk2018/xxgk/xxgk06/202609/t….html` —— 必须相对
 *   列表页地址解析（不能假设单一目录）。导航项（最新征集 / 往期征集）没有
 *   `span.date`，据此过滤。
 * - 详情页有**两套模板**（同一列表里混合出现），本源逐一探测：
 *   1. 栏目内页（/hdjl/yjzj/zjyj/…）：`h2.neiright_Title` 标题、
 *      `.xqLyPc` 日期、正文 `.neiright_JPZ_GK_CP`（内含 TRS_Editor）；
 *   2. 政府信息公开页（/xxgk2018/…）：`h1` 标题（注意页面尾部还有一个
 *      「您访问的链接即将离开…」对话框 h1，需排除）、`.content_top_box` 里的
 *      「发布机关 / 生成日期」字段、正文 `.content_body_box`（部分页用
 *      `.content_body`）。
 *   两套模板的正文里都直接写着截止日期，故统一从正文纯文本抽取。
 * - 附件（PDF）以相对链接出现在正文内（「附件：1.<a href="./W020…pdf">名称</a>」），
 *   按扩展名在正文容器内收集即可。
 *
 * ## 已知取舍
 * 发布机关：xxgk 模板可从「发布机关」字段取到（多为「生态环境部办公厅」）；
 * hdjl 模板没有该字段，退回列表层常量「生态环境部」。发布日期取列表页
 * `span.date`（xxgk 详情页的「生成日期」未再解析，列表值即其发布日）。
 */

/** 列表页：生态环境部「意见征集」（真实路径，见文件头选源依据）。 */
const LIST_URL = 'https://www.mee.gov.cn/hdjl/yjzj/';

/**
 * hdjl 模板无发布机关字段时的兜底（栏目主办方）。
 *
 * 取「生态环境部办公厅」而不是「生态环境部」（issue #21）：本栏目两套详情模板里，
 * xxgk 模板带「发布机关」字段且值为**生态环境部办公厅**，hdjl 模板没有该字段。
 * 实测（2026-09-20 生产库）同一栏目因此出现两种机关名：生态环境部办公厅 29 条
 * （xxgk）、生态环境部 1 条（hdjl，即本兜底）——按机关筛选与统计被拆成两行。
 * 栏目主办方是办公厅，故兜底与另一套模板保持一致。
 */
const DEFAULT_AGENCY = '生态环境部办公厅';

/** 详情正文容器：按两套真实模板依次探测（栏目内页 / 政府信息公开页）。 */
const BODY_SELECTORS = ['.neiright_JPZ_GK_CP', '.content_body_box', '.content_body'];

/** xxgk 模板「发布机关」字段：<div><span>发布机关</span><i>生态环境部办公厅</i></div> */
const AGENCY_FIELD = /发布机关[\s\S]{0,80}?<i[^>]*>([^<]+)<\/i>/;

/** 「您访问的链接即将离开…」对话框标题：不是文章标题，需排除。 */
const LEAVE_DIALOG_TITLE = '您访问的链接即将离开';

/** 取详情正文容器选择器（两套模板取第一个命中的）。 */
function pickBodySelector($: CheerioAPI): string | null {
  for (const selector of BODY_SELECTORS) {
    if ($(selector).length > 0) return selector;
  }
  return null;
}

/** 取标题：栏目内页用 h2.neiright_Title，信息公开页用首个 h1（排除离站对话框）。 */
function extractTitle($: CheerioAPI): string | undefined {
  const neiright = normalizeWhitespace($('h2.neiright_Title').first().text());
  if (neiright.length > 0) return neiright;
  let title: string | undefined;
  $('h1').each((_, element) => {
    if (title !== undefined) return;
    const text = normalizeWhitespace($(element).text());
    if (text.length > 0 && !text.includes(LEAVE_DIALOG_TITLE)) title = text;
  });
  return title;
}

export const meeAdapter: SourceAdapter = {
  id: 'mee',
  name: '生态环境部·意见征集',
  listUrl: LIST_URL,

  async parseList(html: string, baseUrl: string): Promise<NormalizedNotice[]> {
    const $ = cheerio.load(html);
    const notices: NormalizedNotice[] = [];
    const seen = new Set<string>();

    $('li').each((_, element) => {
      const row = $(element);
      const anchor = row.find('a[href]').first();
      const href = anchor.attr('href') ?? '';
      const title = normalizeWhitespace(anchor.text());
      if (title.length < 4 || href.length === 0) return;

      // 列表项 = 条目链接 + <span class="date">；导航项没有日期，据此过滤
      const publishedAt = normalizeDateText(normalizeWhitespace(row.find('span.date').first().text()));
      if (publishedAt === null) return;

      // 链接混用栏目内相对路径与 ../../xxgk2018/ 跨目录相对路径 → 相对列表页解析
      const url = resolveUrl(href, baseUrl);
      if (!url || seen.has(url)) return;
      seen.add(url);

      notices.push({
        title,
        agency: DEFAULT_AGENCY,
        url,
        publishedAt,
        // 截止日期在详情页正文（见文件头），列表层留空由详情补充
        deadlineAt: null,
        bodyText: null,
        attachments: [],
      });
    });

    return notices;
  },

  async parseDetail(html: string, pageUrl: string): Promise<ParsedDetail | null> {
    const $ = cheerio.load(html);

    const title = extractTitle($);
    // hdjl 模板的日期字段（xxgk 模板没有，发布日期由列表层提供）
    const publishedAt =
      normalizeDateText(normalizeWhitespace($('.xqLyPc').first().text())) ?? undefined;
    // xxgk 模板的「发布机关」字段
    const agency =
      normalizeWhitespace(AGENCY_FIELD.exec(html)?.[1] ?? '') ||
      undefined;

    const bodySelector = pickBodySelector($);
    const bodyText = bodySelector ? blockText($, bodySelector) : undefined;
    const deadlineAt = extractDeadline(bodyText) ?? undefined;
    const attachments = bodySelector ? collectAttachments($, pageUrl, bodySelector) : [];

    if (!title && !agency && !publishedAt && !deadlineAt && !bodyText && attachments.length === 0) {
      return null;
    }
    return { title, agency, publishedAt, deadlineAt, bodyText, attachments };
  },
};
