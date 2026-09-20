import * as cheerio from 'cheerio';
import type { NormalizedNotice, ParsedDetail, SourceAdapter } from '../registry.ts';
import { normalizeDateText } from '../../lib/dates.ts';
import {
  agencyFromTitle,
  blockText,
  collectAttachments,
  epochMsToIsoDate,
  extractDeadline,
  normalizeWhitespace,
  parseJsonObject,
  resolveUrl,
} from './extract.ts';

/**
 * 工业和信息化部「意见征集」源适配器（issue #18 M2 扩源）。
 *
 * ## 真实站点结构（2026-09-20 本机实测）
 *
 * - 栏目 `https://www.miit.gov.cn/gzcy/yjzj/`（互动交流 → 意见征集）在运营、条目密集。
 *   列表页**本身是 JS 空壳**（4.8KB），数据来自站内 TRS jpaas 接口
 *   `/api-gateway/jpaas-publish-server/front/page/build/unit`（GET + queryData，
 *   返回 `{data:{html:"…"}}` 片段，与 samr 同一套接口、参数不同）。
 * - 接口片段里每条：
 *   `<li><span class="fr">2026-09-19</span>`
 *       `<a href="/gzcy/yjzj/art/2026/art_<32位>.html" title="…">标题</a>`
 *       `<span class="endtime" style="display:none !important;">1792339200000</span></li>`
 *   `endtime` 是**截止日期的毫秒时间戳**（实测与详情正文「请于2026年10月14日前反馈意见」
 *   完全吻合：1791993600000 → 2026-10-14），故截止日期在列表层即可拿到。
 *   片段里还有 `<li class="empty">` 与 `<li class="border-line">`（分隔 / 占位），
 *   按「有链接 + 有发布日期」过滤。
 * - 详情页：正文容器 `#con_con`；标题与日期在 meta `ArticleTitle` / `PubDate`；
 *   `ContentSource` 是承办司局（无线电管理局），**不用作发布机关**（部本级取自标题兜底）。
 *   正文里截止句写法为「请于YYYY年M月D日前反馈意见」，与列表 endtime 互为印证。
 * - 附件为 `/cms_files/...attach/...pdf`，按扩展名在正文容器内收集。
 *
 * ## 已知取舍
 * - 标题不从详情页覆盖：与 samr 同理，列表 `<a>` 文本即完整标题，详情 meta 可能带
 *   源站换行；列表层标题为空或带省略号时才退回 `<a>` 的 `title` 属性。
 * - 本源的条目里混有「行业标准报批意见的公示」「标准化技术委员会委员名单意见的公示」
 *   一类公示 —— 同属公开征求意见（PRD 定位是聚合公示与征求意见稿），不做主题过滤，
 *   由领域打标与检索承担筛选。
 */

/** 列表接口（TRS jpaas 通用列表接口，见文件头）。 */
const UNIT_API = 'https://www.miit.gov.cn/api-gateway/jpaas-publish-server/front/page/build/unit';
/** 接口参数：从栏目页 unitbuild.js 脚本标签的 queryData 原样搬来（实测可用）。 */
const UNIT_QUERY = {
  parseType: 'buildstatic',
  webId: '8d828e408d90447786ddbe128d495e9e',
  tplSetId: '209741b2109044b5b7695700b2bec37e',
  pageType: 'column',
  tagId: '右侧内容',
  editType: 'null',
  pageId: 'ff3aac0962cb45e48e8e4da69450e847',
};

/** 详情正文容器（实测）。 */
const BODY_SELECTOR = '#con_con';

/** 栏目主办方兜底：本栏目标题多为「关于公开征求…的公示」，取不到机关前缀。 */
const DEFAULT_AGENCY = '工业和信息化部';

export const miitAdapter: SourceAdapter = {
  id: 'miit',
  name: '工业和信息化部·意见征集',
  listUrl: `${UNIT_API}?${new URLSearchParams(UNIT_QUERY).toString()}`,
  /** 列表快照 = 接口响应原文（见 fixtures/README.md「列表快照」） */
  listFixturePath: 'list.json',

  async parseList(payload: string, baseUrl: string): Promise<NormalizedNotice[]> {
    const data = parseJsonObject(payload);
    const fragment = typeof data?.data === 'object' && data.data !== null
      ? (data.data as Record<string, unknown>).html
      : undefined;
    if (typeof fragment !== 'string') return [];

    const $ = cheerio.load(fragment);
    const notices: NormalizedNotice[] = [];
    const seen = new Set<string>();

    $('li').each((_, element) => {
      const row = $(element);
      const anchor = row.find('a[href]').first();
      const href = anchor.attr('href') ?? '';
      if (href.length === 0) return;

      // 发布日期是真实列表项的判据（li.empty / li.border-line 都没有）
      const publishedAt = normalizeDateText(normalizeWhitespace(row.find('span.fr').first().text()));
      if (publishedAt === null) return;

      const rawText = normalizeWhitespace(anchor.text());
      const title = rawText.length > 0 && !rawText.includes('…') && !rawText.includes('...')
        ? rawText
        : normalizeWhitespace(anchor.attr('title') ?? '');
      if (title.length < 4) return;

      // 相对列表地址解析：生产环境条目 href 是站内绝对路径（/gzcy/yjzj/art/…），
      // 对接口地址（同站）解析后仍是站内地址；E2E 里列表地址被重写为 fixture 源站，
      // 于是解析结果落在 fixture 目录内 —— 测试不访问真实站点（ADR-0001）
      const url = resolveUrl(href, baseUrl);
      if (!url || seen.has(url)) return;
      seen.add(url);

      notices.push({
        title,
        agency: agencyFromTitle(title) ?? DEFAULT_AGENCY,
        url,
        publishedAt,
        // 隐藏字段 endtime = 截止日期时间戳（见文件头实测依据）
        deadlineAt: epochMsToIsoDate(row.find('span.endtime').first().text()),
        bodyText: null,
        attachments: [],
      });
    });

    return notices;
  },

  async parseDetail(html: string, pageUrl: string): Promise<ParsedDetail | null> {
    const $ = cheerio.load(html);

    const publishedAt =
      normalizeDateText(
        normalizeWhitespace($('meta[name="PubDate"]').attr('content') ?? '').slice(0, 10),
      ) ?? undefined;

    const bodyText = blockText($, BODY_SELECTOR);
    // 正文截止句与列表 endtime 应一致；解析到则以后者为准（更精确的「日」）
    const deadlineAt = extractDeadline(bodyText) ?? undefined;
    const attachments = collectAttachments($, pageUrl, BODY_SELECTOR);

    if (!publishedAt && !deadlineAt && !bodyText && attachments.length === 0) {
      return null;
    }
    return { publishedAt, deadlineAt, bodyText, attachments };
  },
};
