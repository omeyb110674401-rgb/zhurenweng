import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { NoticeAttachment, NoticeStatus } from '../../db/types.ts';
import { normalizeDateText } from '../../lib/dates.ts';

/**
 * 政府站点页面抽取工具（issue #14 起三个源适配器共用）。
 *
 * 三源分属不同 CMS（人大网 flcaw 接口 / 司法部 TRS / 生态环境部 TRS），
 * 但「正文纯文本」「附件清单」「截止日期」的抽取口径一致，集中在此避免三份拷贝：
 * 各适配器只负责自己页面的列表与详情容器定位。
 */

/** 折叠空白：政府页面正文大量使用全角空格与换行，统一压成单空格并去首尾。 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 相对链接 → 绝对 URL（只允许 http/https，过滤 javascript:、mailto: 等）。 */
export function resolveUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** 接口字段的安全取值：非字符串（null/数字/缺失）统一成空串。 */
export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 容错 JSON 解析：列表 / 详情接口返回的可能是错误页或 WAF 拦截页（HTML），
 * 此时返回 null 由调用方降级，而不是抛异常中断整轮抓取。
 */
export function parseJsonObject(payload: string): Record<string, unknown> | null {
  const trimmed = payload.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 从接口响应取数组字段（如 rows）；非数组时返回空数组。 */
export function rowsOf(data: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = data[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
  );
}

/**
 * 正文 → 纯文本：按「最内层块级元素」逐块取文本（政府页面正文混用 `<p>` 与
 * `<div>` 两种排版，只取 p 会漏掉整段内容），块间以换行连接；
 * 无块级元素时退化为整块文本。containerSelector 省略时作用于整篇文档。
 *
 * 先在**克隆体**上剔除 `script / style / noscript`：部分政务站把内联脚本直接写在
 * 正文容器里（如民航局 `div.content` 末尾的 `appendixfile` 赋值、铁路局 `#Zoom`
 * 里的 `document.write`），不剔除会混进正文、污染检索与后续 AI 摘要输入。
 * 用克隆而非就地删除，避免影响调用方后续的附件收集。
 */
export function blockText($: CheerioAPI, containerSelector?: string): string | undefined {
  const found = containerSelector ? $(containerSelector).first() : $.root();
  if (found.length === 0) return undefined;
  const root = found.clone();
  root.find('script, style, noscript').remove();

  const blocks: string[] = [];
  root.find('p, div, li, td').each((_, element) => {
    const node = $(element);
    // 只取最内层块：含嵌套块级子元素的容器交给其子元素输出，避免同一段文字重复
    if (node.children('p, div, li, td').length > 0) return;
    const text = normalizeWhitespace(node.text());
    if (text.length > 0) blocks.push(text);
  });
  if (blocks.length > 0) return blocks.join('\n');

  const fallback = normalizeWhitespace(root.text());
  return fallback.length > 0 ? fallback : undefined;
}

/** HTML 片段（如接口返回的正文 HTML）→ 纯文本。 */
export function htmlFragmentText(fragment: string): string | undefined {
  if (normalizeWhitespace(fragment).length === 0) return undefined;
  return blockText(cheerio.load(fragment));
}

/** 附件文件扩展名（草案文本 / 说明通常为 PDF、Word 等）。 */
const ATTACHMENT_PATH = /\.(pdf|docx?|wps|xls[xm]?|zip|rar)$/i;

/**
 * 按扩展名收集附件链接（去重、保序）：名称取链接文本，链接文本为空时退化为文件名。
 * containerSelector 省略时扫描整篇文档。
 *
 * 选择器命中多个容器时**逐个扫描**（不是只取第一个）：市场监管总局详情页的附件
 * 链接在 `ul.contentLeft0102box` 里，而该 class 在页面上出现两次（前一个是空占位、
 * 后一个才是附件清单）——只取第一个会一个附件都收不到。`seen` 保证跨容器去重。
 */
export function collectAttachments(
  $: CheerioAPI,
  pageUrl: string,
  containerSelector?: string,
): NoticeAttachment[] {
  const roots = containerSelector ? $(containerSelector).toArray() : [$.root()[0]];
  if (roots.length === 0) return [];

  const attachments: NoticeAttachment[] = [];
  const seen = new Set<string>();
  for (const element of roots) {
    $(element)
      .find('a[href]')
      .each((_, anchorElement) => {
        const anchor = $(anchorElement);
        const url = resolveUrl(anchor.attr('href') ?? '', pageUrl);
        if (!url || !ATTACHMENT_PATH.test(new URL(url).pathname)) return;
        if (seen.has(url)) return;
        seen.add(url);
        const name = normalizeWhitespace(anchor.text());
        const fallbackName = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? url);
        attachments.push({ name: name.length > 0 ? name : fallbackName, url });
      });
  }
  return attachments;
}

/**
 * 日期文本（中文 / 横线 / 斜杠 / 点分四种写法，均要求到「日」）。
 * 与 lib/dates.ts 的 normalizeDateText 支持范围严格一致 —— 正则认了但转不出来的
 * 写法等于没认（斜杠写法就曾如此，抽到了日期却在归一化那步变成 null）。
 */
const DATE_TEXT = String.raw`(\d{4}年\d{1,2}月\d{1,2}日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})`;

/**
 * 从正文纯文本中抽取「征求意见截止日期」。
 *
 * 官方通知里截止日期的写法并不统一（实测各源各不相同），按优先级依次匹配：
 * 1. `征求意见截止时间为2026年10月14日` / `截止日期：2026-10-14`（司法部、生态环境部常见）；
 * 2. `征求意见时间为2026年3月20日至2026年4月19日` —— 取区间结束日（司法部最常见写法）；
 * 3. `请于2026年10月14日前反馈` —— 取「于…前」中的日期。
 * 都匹配不到时返回 null（保持字段为空，绝不用列表页日期或抓取日期顶替）。
 *
 * 规则 1 的引导词用 `[为:：]*` 而非「最多一个」：民航局实测写法是
 * `意见反馈截止日期为：2026年10月7日`（「为」与「：」**同时**出现），
 * 旧写法只允许一个引导字符，导致该写法整条抽不到截止日期。
 */
export function extractDeadline(bodyText: string | undefined): string | null {
  if (!bodyText) return null;
  const text = normalizeWhitespace(bodyText);
  const rules = [
    new RegExp(String.raw`截止(?:日期|时间)?\s*[为:：]*\s*${DATE_TEXT}`),
    new RegExp(String.raw`(?:至|到)\s*${DATE_TEXT}`),
    new RegExp(String.raw`(?:请|应)?于\s*${DATE_TEXT}\s*(?:前|之前)`),
  ];
  for (const rule of rules) {
    const match = rule.exec(text);
    if (match) {
      const iso = normalizeDateText(match[1]);
      if (iso) return iso;
    }
  }
  return null;
}

/**
 * 按序返回第一个「有正文」的容器选择器；都为空时返回 undefined。
 *
 * 用于详情页模板不唯一的源：交通运输部「意见征集」栏目里混排了民航局
 * （`div.content`）与国家铁路局（`#Zoom`）的条目 —— 按 host 分派在 E2E fixture
 * 里会失效（fixture 源站 host 是本地地址，与生产 host 不同，两条代码路径不一致），
 * 因此改为**按内容探测**：同一份选择器列表在生产与快照上走同一条路径。
 * 顺序按「主正文容器」的常见程度排列，取到即止，避免误取侧栏或页脚。
 */
export function firstContentSelector(
  $: CheerioAPI,
  selectors: readonly string[],
): string | undefined {
  for (const selector of selectors) {
    const text = blockText($, selector);
    if (text !== undefined && text.length > 0) return selector;
  }
  return undefined;
}

/**
 * 源列表自带的状态标注 → 条目状态。
 *
 * 多个部委栏目直接在标题或状态列里给出权威状态，写法实测三种：
 * 交通运输部 `[进行中]` / `[已结束]`、教育部 `[已结束]`、市场监管总局 `(进行中)`、
 * 国家发展改革委 `【进行中】`。两侧括号形式不一，这里统一剥离后再认词。
 * 未标注或词不在表内时返回 undefined（调用方退回截止日期推导）。
 */
const STATUS_WORD: Record<string, NoticeStatus> = {
  进行中: 'open',
  征集中: 'open',
  已结束: 'closed',
  已截止: 'closed',
};

/** 状态词的可选分支（正则源码片段，见下方 STATUS_MARKER 的构造方式）。 */
const STATUS_ALTERNATION = Object.keys(STATUS_WORD).join('|');

export function parseStatusText(text: string): NoticeStatus | undefined {
  const word = normalizeWhitespace(text).replace(/^[【[(（\s]+|[】\])）\s]+$/g, '');
  return STATUS_WORD[word];
}

/**
 * 标题里的状态标注：剥离并返回状态（`[已结束]教育部关于…` → closed + `教育部关于…`）。
 *
 * 标注位置实测两种：**前缀**（教育部、交通运输部）与**后缀**（国家发展改革委
 * `…意见的公告[已结束]`），故两端都试。只在括号紧贴词、且位于标题首/尾时剥离，
 * 避免误伤标题正文里出现的括号内容（如《办法（试行）》）。
 * 未标注时 status 为 undefined、text 原样返回。
 *
 * 与 agencyFromTitle 同理，这里用 `new RegExp` 构造而**不写正则字面量**：本文件里
 * 含全角括号的字符类字面量（`/^[【[(（]…/`）会让 Node 的类型擦除解析器误判，
 * 在几十行之外报 ERR_INVALID_TYPESCRIPT_SYNTAX（见文件内 agencyFromTitle 的说明）。
 */
const OPEN_BRACKETS = '【\\[（(';
const CLOSE_BRACKETS = '】\\]）)';
// 第 1 捕获组 = 标注本体（不含分隔符），交给 parseStatusText 认词
const STATUS_MARKER = new RegExp(
  `^([${OPEN_BRACKETS}]\\s*(?:${STATUS_ALTERNATION})\\s*[${CLOSE_BRACKETS}])\\s*[-—－]?\\s*`,
);
const STATUS_MARKER_TAIL = new RegExp(
  `\\s*([${OPEN_BRACKETS}]\\s*(?:${STATUS_ALTERNATION})\\s*[${CLOSE_BRACKETS}])$`,
);

export function stripStatusMarker(title: string): { status?: NoticeStatus; text: string } {
  const text = normalizeWhitespace(title);
  const head = STATUS_MARKER.exec(text);
  if (head) {
    return { status: parseStatusText(head[1]), text: text.slice(head[0].length).trim() };
  }
  const tail = STATUS_MARKER_TAIL.exec(text);
  if (tail) {
    return { status: parseStatusText(tail[1]), text: text.slice(0, tail.index).trim() };
  }
  return { text };
}

/**
 * 毫秒时间戳 → ISO 日期（YYYY-MM-DD，UTC）。
 *
 * 工业和信息化部列表项用隐藏字段 `<span class="endtime">1792339200000</span>`
 * 承载截止日期（实测该值与详情正文「请于2026年10月14日前反馈意见」完全一致）。
 * 该站时间戳取当日 00:00 UTC，UTC 与东八区落在同一日期，故按 UTC 切日即可。
 */
export function epochMsToIsoDate(value: string | undefined): string | null {
  if (!value) return null;
  const ms = Number(normalizeWhitespace(value));
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * 从通知标题前缀取发布机关：「司法部、中国人民银行…关于《…》公开征求意见的通知」→ 前缀。
 * 前缀必须含机关字样（部/委/局/院/署/办/厅/政府/人大/银行/监管）才采信，
 * 避免把「公开征求…」一类短语当成机关；取不到时返回 undefined（由适配器兜底常量）。
 *
 * 注意：这里刻意用 indexOf 拆前缀而**不用正则字面量**。Node 直接运行 .ts（类型擦除）
 * 时，本文件里若出现 `/^(.{2,60}?)关于[…]/` 这样的正则字面量，解析器会误判为除号，
 * 在几十行之外报 ERR_INVALID_TYPESCRIPT_SYNTAX（实测踩过，换转义/换字符类都无效）。
 * 改动本函数时请保持无正则字面量的写法。
 */
export function agencyFromTitle(title: string): string | undefined {
  const text = normalizeWhitespace(title);
  const at = text.indexOf('关于');
  // 前缀长度 2~60 字，且「关于」之后紧跟书名号 / 括号（《 〔 （）才视为机关前缀
  if (at < 2 || at > 60) return undefined;
  if (!'《〔（'.includes(text.charAt(at + 2))) return undefined;
  const candidate = text.slice(0, at).trim();
  return /[部委局院署办厅]|政府|人大|银行|监管/.test(candidate) ? candidate : undefined;
}
