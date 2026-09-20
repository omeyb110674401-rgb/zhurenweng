import * as cheerio from 'cheerio';
import type { NormalizedNotice, ParsedDetail, SourceAdapter } from '../registry.ts';
import { normalizeDateText } from '../../lib/dates.ts';
import {
  agencyFromTitle,
  blockText,
  collectAttachments,
  extractDeadline,
  normalizeWhitespace,
  parseJsonObject,
  parseStatusText,
  resolveUrl,
} from './extract.ts';

/**
 * 国家市场监督管理总局「征集调查」源适配器（issue #18 M2 扩源）。
 *
 * ## 为什么是市场监管总局（选源依据，2026-09-20 本机实测）
 *
 * 栏目 `https://www.samr.gov.cn/hd/zjdc/`（互动 → 征集调查）在运营、条目密集，
 * 且**列表自带「征集期」与状态列**，是本批扩源里结构化程度最高的一个。
 *
 * ## 真实站点结构（实测）
 *
 * - 列表页**本身是 JS 空壳**（4.6KB，正文由脚本填充），数据来自站内接口
 *   `/api-gateway/jpaas-publish-server/front/page/build/unit`（TRS jpaas 通用列表接口，
 *   见 `unitbuild.js`：GET + queryData 参数，返回 `{data:{html:"…"}}` 片段）。
 *   适配器直接消费该接口（与 npc 消费 flcaw 接口同构，列表快照存 list.json）。
 * - 接口片段里每条：
 *   `<li class="zjnav04Left02_content">`
 *     `<div class="doctitle"><a href="/hd/zjdc/art/2026/art_<32位>.html" title="…">标题</a></div>`
 *     `<div class="doctime tim">2026-09-17至2026-10-17</div>`  ← **征集期**（起 至 止）
 *     `<div class="docstatus stu">(进行中)</div>`
 *   表头行同样是 `li.zjnav04Left02_content`，但没有 `<a>`，据此过滤。
 * - **截止日期取自列表的征集期结束日**，不依赖详情页：实测三条详情里只有一条正文写了
 *   「意见反馈截止时间为…」，另两条正文没有截止句（征集期只存在于列表）。
 * - 详情页：正文容器 `div.Three_xilan_07`（三条实测一致，页面其余 class 是
 *   `Three_xilan_01/02/05/08` 等分享 / 检索装饰块）；元信息在 meta
 *   `ArticleTitle` / `PubDate` / `ContentSource`（司局，**不用作发布机关** ——
 *   发布机关是发文的部委本级，取自标题前缀）。
 * - 附件为 `/cms_files/...attach/....pdf?fileName=…` 形式（带 fileName 查询参数），
 *   按扩展名在正文容器内收集即可（`resolveUrl` 保留查询串）。
 *
 * ## 已知取舍
 * - 标题取 `<a>` 的**文本**而非 `title` 属性：接口片段里 `title` 属性带换行
 *   （「关于出口\n转内销产品…」），折成空格后标题里会多出空格；`<a>` 文本是同一标题
 *   的无换行版本（实测未被截断）。`<a>` 文本为空或带省略号时才退回 `title` 属性。
 * - 征集期「起」作为发布日期（列表无独立发布日期；详情 `PubDate` 与征集期起同日）。
 */

/** 列表接口（TRS jpaas 通用列表接口，见文件头）。 */
const UNIT_API = 'https://www.samr.gov.cn/api-gateway/jpaas-publish-server/front/page/build/unit';
/** 接口参数：从栏目页 `unitbuild.js` 脚本标签的 queryData 原样搬来（实测可用）。 */
const UNIT_QUERY = {
  parseType: 'bulidstatic',
  webId: '29e9522dc89d4e088a953d8cede72f4c',
  tplSetId: '5c30fb89ae5e48b9aefe3cdf49853830',
  pageType: 'column',
  tagId: '内容区域',
  editType: 'null',
  pageId: 'b00644872e354a96b66e3cd954e9996f',
};

/** 详情正文容器（三条实测一致，见文件头）。 */
const BODY_SELECTOR = '.Three_xilan_07';

/**
 * 详情附件容器：附件不在正文里，而在正文之后的「附件下载」清单
 * `ul.contentLeft0102box > li.contentLeft0103 > a[href$=".pdf?fileName=…"]`。
 * 该 class 在页面上出现两次（前一个是空占位），故按容器**逐个扫描**
 * （collectAttachments 已支持多容器，见其注释）。
 */
const ATTACHMENT_SELECTOR = 'ul.contentLeft0102box';

/** 征集期：「2026-09-17至2026-10-17」（也有用「到」的写法）。 */
const PERIOD_SEPARATOR = /[至到~～]/;

/** 栏目主办方兜底（标题取不到机关前缀时）。 */
const DEFAULT_AGENCY = '市场监管总局';

export const samrAdapter: SourceAdapter = {
  id: 'samr',
  name: '市场监管总局·征集调查',
  listUrl: `${UNIT_API}?${new URLSearchParams(UNIT_QUERY).toString()}`,
  /** 列表快照 = 接口响应原文（见 fixtures/README.md「列表快照」） */
  listFixturePath: 'list.json',

  async parseList(payload: string, baseUrl: string): Promise<NormalizedNotice[]> {
    // 接口不可用 / 被 WAF 拦成 HTML 时返回空列表（不抛异常中断整轮抓取）
    const data = parseJsonObject(payload);
    const fragment = typeof data?.data === 'object' && data.data !== null
      ? (data.data as Record<string, unknown>).html
      : undefined;
    if (typeof fragment !== 'string') return [];

    const $ = cheerio.load(fragment);
    const notices: NormalizedNotice[] = [];
    const seen = new Set<string>();

    $('li.zjnav04Left02_content').each((_, element) => {
      const row = $(element);
      const anchor = row.find('.doctitle a[href]').first();
      const href = anchor.attr('href') ?? '';
      if (href.length === 0) return; // 表头行没有链接（见文件头）

      const rawText = normalizeWhitespace(anchor.text());
      const title = rawText.length > 0 && !rawText.includes('…') && !rawText.includes('...')
        ? rawText
        : normalizeWhitespace(anchor.attr('title') ?? '');
      if (title.length < 4) return;

      // 相对列表地址解析：生产环境条目 href 是站内绝对路径（/hd/zjdc/…），
      // 对接口地址（同站）解析后仍是站内地址；E2E 里列表地址被重写为 fixture 源站，
      // 于是解析结果落在 fixture 目录内 —— 测试不访问真实站点（ADR-0001）
      const url = resolveUrl(href, baseUrl);
      if (!url || seen.has(url)) return;
      seen.add(url);

      // 征集期：起 至 止 —— 起作发布日期，止作截止日期（本源的截止日期唯一来源）
      const [startText, endText] = normalizeWhitespace(row.find('.doctime').first().text())
        .split(PERIOD_SEPARATOR);
      const publishedAt = normalizeDateText(startText ?? '');
      const deadlineAt = normalizeDateText(endText ?? '');

      notices.push({
        title,
        agency: agencyFromTitle(title) ?? DEFAULT_AGENCY,
        url,
        publishedAt,
        deadlineAt,
        // 状态列是源给的权威标注；截止日期解析不到时由抓取管线采用它
        status: parseStatusText(row.find('.docstatus').first().text()),
        bodyText: null,
        attachments: [],
      });
    });

    return notices;
  },

  async parseDetail(html: string, pageUrl: string): Promise<ParsedDetail | null> {
    const $ = cheerio.load(html);

    // 标题**刻意不从详情页覆盖**：详情 meta ArticleTitle 带源站换行（折成空格后标题里
    // 多出空格），列表层 `<a>` 文本是同一标题的无换行版本，更干净（见文件头取舍）。
    const publishedAt =
      normalizeDateText(
        normalizeWhitespace($('meta[name="PubDate"]').attr('content') ?? '').slice(0, 10),
      ) ?? undefined;

    const bodyText = blockText($, BODY_SELECTOR);
    // 多数条目的正文没有截止句（征集期只在列表，见文件头）：解析不到就返回 undefined，
    // 由抓取管线的 mergeDetail 保留列表层的征集期结束日
    const deadlineAt = extractDeadline(bodyText) ?? undefined;
    const attachments = collectAttachments($, pageUrl, ATTACHMENT_SELECTOR);

    if (!publishedAt && !deadlineAt && !bodyText && attachments.length === 0) {
      return null;
    }
    return { publishedAt, deadlineAt, bodyText, attachments };
  },
};
