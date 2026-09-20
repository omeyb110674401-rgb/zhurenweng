import * as cheerio from 'cheerio';
import type { NormalizedNotice, ParsedDetail, SourceAdapter } from '../registry.ts';
import { normalizeDateText } from '../../lib/dates.ts';
import { blockText, extractDeadline, normalizeWhitespace, parseJsonObject, resolveUrl } from './extract.ts';

/**
 * 住房和城乡建设部「征求意见」源适配器（issue #28，第 9 个源）。
 *
 * ## 接入形态：TRS jpaas 接口列表（与市场监管总局、工业和信息化部同族）
 *
 * 栏目页 `https://www.mohurd.gov.cn/gongkai/fdzdgknr/zqyj/index.html` 是 **JS 空壳**
 * （gzip 后 1.8KB），条目由站内接口渲染：`/api-gateway/jpaas-publish-server/front/page/build/unit`
 * （GET + queryData，响应 `{data:{html:"…"}}` 片段）。参数从栏目页 `unitbuild.js`
 * 脚本标签的 queryData 原样搬来（实测可用）。
 *
 * 列表行 `<li class="long-deta">` **直接带截止日期**：
 * `<span class="date-info">截止日期 2026-10-18</span>` —— 本源没有独立的发布机关 /
 * 状态列，截止日期是列表层唯一的日期字段，也是本源截止日期的权威来源。
 *
 * ## 踩坑记录：一次被误判成「站点加授权校验」的故障
 *
 * 该接口一度稳定返回 `{"success":false,"data":{}}`，而脚本来自
 * `/cms_files/default/script/AuthorizedRead/unitbuild.js`，很容易误判为站点加了
 * 「授权读取」会话校验（试过带 cookie jar 重放、`X-Requested-With` 等多种请求头，
 * 全部无效）。**真正的原因是本机 shell 把中文编成了 GBK**：
 * `curl --data-urlencode "tagId=内容1"` 实际发出 `tagId=%c4%da%c8%dd1`（GBK 百分号
 * 编码），而接口要 UTF-8 的 `%E5%86%85%E5%AE%B91`——服务端匹配不到 tag 就返回
 * success:false。改用 Node 的 `URLSearchParams` 构造请求（生产爬虫正是如此）一切正常，
 * 且爬虫 UA、无 UA 都能取到数据。**结论：站点从未拦我们；中文查询参数必须用 UTF-8
 * 百分号编码，Windows 上不要用 curl 的 `--data-urlencode` 传中文。**
 *
 * ## 分页与「只取第一页」的依据
 *
 * 接口返回的分页参数（`oLayPageRender(..., {rows:"20", count:"585", pageNo:"1"})`）
 * 只在前端脚本里消费：把 `pageNo` / `rows` / `page` / `limit` 等各种组合作为查询参数
 * 回传都被忽略（实测均返回第 1 页）。因此本源**只取第 1 页（20 条）**，依据是排序：
 * 列表按截止日期降序（新发布的公告截止日必然更大 → 永远落在第 1 页顶部），
 * 掉出第 1 页的都是**已在库里**的旧条目 —— 对每日增量抓取而言第 1 页足够。
 * 这条推理依赖「新条目截止日更大」，若日后住建部出现「截止期极短的公告」批量发布，
 * 需要回头重新评估（届时先用浏览器 network 面板确认真正的分页参数）。
 *
 * ## 已知取舍
 *
 * - 标题取列表行 `<span class="title-info">` 的文本，被截断（带 `…`）时才退回 `<a title>`；
 *   详情页 `meta[name=ArticleTitle]` **刻意不用**：它带源站换行，折成空格后标题里会
 *   多出空格（「…行政复议 办法（征求意见稿）…」）。
 * - 机关名取自标题前缀，但**不用共享的 `agencyFromTitle`**：本源大量标题写作
 *   「住房城乡建设部办公厅关于**国家标准**《…》公开征求意见的通知」，「关于」之后
 *   跟的是标准类型词而非书名号，共享助手会返回 undefined 并退到默认值，把源站真实
 *   署名的「办公厅」丢掉（机关名是忠实于源站的显示值，见 lib/agencies.ts）。
 * - 附件链接是下载接口（`/api-gateway/jpaas-web-server/front/document/download?fileUrl=…`，
 *   **URL 里没有扩展名**），共享的 `collectAttachments` 按扩展名过滤会全部漏掉，
 *   故本源按容器 + 链接路径收集，名称取链接文本。
 */

/** 列表接口（TRS jpaas 通用列表接口，见文件头）。 */
const UNIT_API = 'https://www.mohurd.gov.cn/api-gateway/jpaas-publish-server/front/page/build/unit';
/** 接口参数：从栏目页 `unitbuild.js` 脚本标签的 queryData 原样搬来（实测可用）。 */
const UNIT_QUERY = {
  parseType: 'bulidstatic',
  webId: '86ca573ec4df405db627fdc2493677f3',
  tplSetId: 'fc259c381af3496d85e61997ea7771cb',
  pageType: 'column',
  tagId: '内容1',
  editType: 'null',
  pageId: 'Pgf4Z2WE0oiRbuRzvrIVA',
};

/** 详情正文容器（实测：`div.editor-content` 只含正文，元数据表在其外）。 */
const BODY_SELECTOR = '.editor-content';
/** 详情附件容器：正文之后的「附件下载」清单。 */
const ATTACHMENT_SELECTOR = '.editorContent-download';
/** 附件链接的路径特征（下载接口，无扩展名）。 */
const DOWNLOAD_PATH = '/document/download';

/** 栏目主办方兜底（标题取不到机关前缀时）。 */
const DEFAULT_AGENCY = '住房城乡建设部';

/**
 * 机关名：取「关于」之前的前缀，并要求它看起来像机关名。
 * 与共享的 `agencyFromTitle` 的差别见文件头「已知取舍」。
 */
function agencyOf(title: string): string | undefined {
  const text = normalizeWhitespace(title);
  const at = text.indexOf('关于');
  if (at < 2 || at > 30) return undefined;
  const candidate = text.slice(0, at).trim();
  return /[部委局院署办厅]|政府|人大|银行|监管/.test(candidate) ? candidate : undefined;
}

/** 附件：容器内指向下载接口的链接，名称取链接文本。 */
function downloadAttachments(
  $: cheerio.CheerioAPI,
  pageUrl: string,
): NormalizedNotice['attachments'] {
  const attachments: NormalizedNotice['attachments'] = [];
  const seen = new Set<string>();
  $(ATTACHMENT_SELECTOR)
    .find('a[href]')
    .each((_, element) => {
      const anchor = $(element);
      const href = anchor.attr('href') ?? '';
      if (!href.includes(DOWNLOAD_PATH)) return;
      const url = resolveUrl(href, pageUrl);
      if (url === null || seen.has(url)) return;
      seen.add(url);
      const name = normalizeWhitespace(anchor.text()) || normalizeWhitespace(anchor.attr('title') ?? '');
      if (name.length === 0) return;
      attachments.push({ name, url });
    });
  return attachments;
}

export const mohurdAdapter: SourceAdapter = {
  id: 'mohurd',
  name: '住房城乡建设部·征求意见',
  listUrl: `${UNIT_API}?${new URLSearchParams(UNIT_QUERY).toString()}`,
  /** 列表快照 = 接口响应原文（见 fixtures/README.md「列表快照」） */
  listFixturePath: 'list.json',

  async parseList(payload: string, baseUrl: string): Promise<NormalizedNotice[]> {
    // 接口不可用 / 被 WAF 拦成 HTML 时返回空列表（不抛异常中断整轮抓取）
    const data = parseJsonObject(payload);
    const fragment =
      typeof data?.data === 'object' && data.data !== null
        ? (data.data as Record<string, unknown>).html
        : undefined;
    if (typeof fragment !== 'string') return [];

    const $ = cheerio.load(fragment);
    const notices: NormalizedNotice[] = [];
    const seen = new Set<string>();

    $('li.long-deta').each((_, element) => {
      const row = $(element);
      const anchor = row.find('a[href]').first();
      const href = anchor.attr('href') ?? '';
      if (href.length === 0) return;

      // 标题：优先列表行文本（无换行），被截断时才用 title 属性（见文件头取舍）
      const rowText = normalizeWhitespace(row.find('.title-info').first().text());
      const attrText = normalizeWhitespace(anchor.attr('title') ?? '');
      const title =
        rowText.length >= 4 && !rowText.includes('…') && !rowText.includes('...')
          ? rowText
          : attrText;
      if (title.length < 4) return;

      // 相对列表地址解析：生产环境条目 href 是站内绝对路径（/gongkai/zc/wjk/art/…），
      // 对接口地址（同站）解析后仍是站内地址；E2E 里列表地址被重写为 fixture 源站，
      // 于是解析结果落在 fixture 目录内 —— 测试不访问真实站点（ADR-0001）
      const url = resolveUrl(href, baseUrl);
      if (!url || seen.has(url)) return;
      seen.add(url);

      // 「截止日期 2026-10-18」直接命中 extractDeadline 的「截止日期 X」规则，
      // 故复用共享抽取（与详情正文的截止句同一套口径）
      const deadlineAt = extractDeadline(normalizeWhitespace(row.find('.date-info').first().text()));

      notices.push({
        title,
        agency: agencyOf(title) ?? DEFAULT_AGENCY,
        url,
        // 列表无发布日期（只有截止日期），留给详情页的 meta PubDate 补
        publishedAt: null,
        deadlineAt,
        bodyText: null,
        attachments: [],
      });
    });

    return notices;
  },

  async parseDetail(html: string, pageUrl: string): Promise<ParsedDetail | null> {
    const $ = cheerio.load(html);

    // 标题**刻意不从详情页覆盖**：meta ArticleTitle 带源站换行，折成空格后标题里
    // 多出空格（「…行政复议 办法（征求意见稿）…」），列表层是同一标题的无换行版本
    const publishedAt =
      normalizeDateText(
        normalizeWhitespace($('meta[name="PubDate"]').attr('content') ?? '').slice(0, 10),
      ) ?? undefined;

    const bodyText = blockText($, BODY_SELECTOR);
    // 正文的「意见反馈截止时间为X」与列表的「截止日期 X」实测一致；解析不到时返回
    // undefined，由抓取管线保留列表层取值
    const deadlineAt = extractDeadline(bodyText) ?? undefined;
    const attachments = downloadAttachments($, pageUrl);

    if (!publishedAt && !deadlineAt && !bodyText && attachments.length === 0) {
      return null;
    }
    return { publishedAt, deadlineAt, bodyText, attachments };
  },
};
