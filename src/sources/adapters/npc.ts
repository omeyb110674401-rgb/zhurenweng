import type { NormalizedNotice, ParsedDetail, SourceAdapter } from '../registry.ts';
import { normalizeDateText } from '../../lib/dates.ts';
import {
  htmlFragmentText,
  normalizeWhitespace,
  parseJsonObject,
  resolveUrl,
  rowsOf,
  textOf,
} from './extract.ts';

/**
 * 全国人大网「法律草案征求意见」源适配器（issue #3 接入；issue #14 对着活站重写）。
 *
 * ## 真实站点结构（2026-09-20 在服务器实测；本机走代理，结论不同，以服务器为准）
 *
 * - 栏目首页 http://www.npc.gov.cn/flcaw/ 是**前端渲染页**：HTML 里只有空表格，
 *   条目由 assets/api/list_service.js 调 JSON 接口后写入 DOM。故本源以该接口作为
 *   列表页（listUrl）：
 *     http://www.npc.gov.cn/flcaw/flca-list?flag=0&type=0&page=1&per_page=100
 *   flag=0「正在进行征求意见」（实测 5 条）；flag=1/2「已结束」（实测 total=389，
 *   且 flag=2 不含进行中条目 —— 两个值语义相同）。本源只取进行中条目：已截止条目
 *   一旦入库就留在库里，历史自然累积；需要全量回填时另起任务改 flag 即可。
 *   每条字段：flxxmc 标题 / ksrq 起始日 / jsrq 截止日 / flxxId 条目 ID。
 * - 条目人工页 userIndex.html?lid=<flxxId> 同样是前端渲染页（页内脚本再调接口），
 *   正文不在 HTML 里；页内脚本 userService.GetFlxxId 调用的
 *     /flcaw/flca/<lid>/info/     （实测 200 application/json）
 *   才带正文：flxxmc 标题、tsy 正文（页面 #fcontent 渲染的正是该字段）、ksrq/jsrq。
 *   故本源用 detailContentUrl 指向该接口，而 notice.url 仍是人工页 —— 入库唯一键
 *   与用户可见的「官方原文」必须是可读页面，不能是接口地址。
 *
 * ## TLS 处置（issue #14；后来者最容易踩的坑）
 *
 * www.npc.gov.cn 的 HTTPS **在 TLS 握手阶段就被服务端拒绝**：curl 报
 * `sslv3 alert handshake failure`，openssl s_client 同样在 ClientHello 后收到
 * handshake_failure。换 TLS1.2、降 `--ciphers DEFAULT@SECLEVEL=1`、加 `--insecure`
 * 全部无效 —— 这不是证书链验证失败，**跳过证书校验（rejectUnauthorized: false）
 * 解决不了**；只有 http:// 可用（实测同路径 200，爬虫 UA 也被接受）。
 * 因此本源整体使用 http://：这是让管线拿到真实数据的最小处置。风险与缓解：
 * - 风险：明文传输，理论上可被中间人篡改/窃听（官方站点自身也提供 http 入口）。
 * - 缓解：只聚合官方公开信息、不携带任何凭据/Cookie、附件只记录链接不下载正文、
 *   不基于该内容做任何鉴权或写操作。
 * - 若站点日后恢复 https（浏览器可正常打开即为信号），把本文件的 `http://` 换成
 *   `https://` 即可，无需其他改动。
 *
 * ## 已知取舍
 * 接口不提供发布机关字段（人工页也没有「发布机关：」文本），机关取栏目主办方常量；
 * 草案电子文档（/flcaw/flca/<lid>/attachment.pdf，实测可达、单个 30MB+）需要额外一次
 * /fjxx/ 接口调用才能拿到文件名，本轮不抓 —— 附件留空，而不是臆造文件名。
 */

/** 列表接口（进行中征求意见）。生产地址写死 http（见上方 TLS 处置）。 */
const LIST_URL = 'http://www.npc.gov.cn/flcaw/flca-list?flag=0&type=0&page=1&per_page=100';
/** 条目人工页文件名（相对列表接口地址解析，测试环境自动指向 fixture 快照）。 */
const DETAIL_PAGE_FILE = 'userIndex.html';
/** 详情内容接口目录：<flcaw>/flca/<lid>/info/ */
const DETAIL_API_DIR = 'flca';

/** 接口不提供发布机关；flcaw 征求意见系统由全国人大常委会法制工作委员会主办。 */
const DEFAULT_AGENCY = '全国人大常委会法制工作委员会';

/** 从人工页 URL 取 lid（详情接口路径由它拼出）。 */
function lidFromDetailUrl(detailUrl: string): string | null {
  try {
    const lid = new URL(detailUrl).searchParams.get('lid');
    return lid !== null && lid.length > 0 ? lid : null;
  } catch {
    return null;
  }
}

export const npcLawDraftsAdapter: SourceAdapter = {
  id: 'npc',
  name: '全国人大网·法律草案征求意见',
  listUrl: LIST_URL,
  /** 本源列表是 JSON 接口，fixture 快照为 list.json（见 fixtures/npc/） */
  listFixturePath: 'list.json',

  async parseList(payload: string, baseUrl: string): Promise<NormalizedNotice[]> {
    const data = parseJsonObject(payload);
    if (!data) return [];

    const notices: NormalizedNotice[] = [];
    const seen = new Set<string>();
    for (const row of rowsOf(data, 'rows')) {
      const title = normalizeWhitespace(textOf(row.flxxmc));
      const lid = normalizeWhitespace(textOf(row.flxxId));
      if (title.length < 4 || lid.length === 0) continue;

      // 详情页地址相对列表接口地址解析：生产 → …/flcaw/userIndex.html?lid=<id>；
      // 测试 → <fixture 源站>/npc/userIndex.html?lid=<id>（详情快照按 lid 命名）
      const url = resolveUrl(`${DETAIL_PAGE_FILE}?lid=${encodeURIComponent(lid)}`, baseUrl);
      if (!url || seen.has(url)) continue;
      seen.add(url);

      notices.push({
        title,
        agency: DEFAULT_AGENCY,
        url,
        // 接口给的是「2026-08-28 00:00:00」，normalizeDateText 取日期部分
        publishedAt: normalizeDateText(textOf(row.ksrq)),
        deadlineAt: normalizeDateText(textOf(row.jsrq)),
        bodyText: null,
        attachments: [],
      });
    }
    return notices;
  },

  detailContentUrl(notice: NormalizedNotice): string | null {
    const lid = lidFromDetailUrl(notice.url);
    if (!lid) return null;
    // 相对人工页地址解析：生产 → …/flcaw/flca/<lid>/info/；测试 → <fixture>/npc/flca/<lid>/info/
    return resolveUrl(`${DETAIL_API_DIR}/${encodeURIComponent(lid)}/info/`, notice.url);
  },

  async parseDetail(payload: string, _pageUrl: string): Promise<ParsedDetail | null> {
    const data = parseJsonObject(payload);
    // 接口被拦截或返回错误页时降级：保留列表层字段（标题 / 起止日期）
    if (!data) return null;

    const title = normalizeWhitespace(textOf(data.flxxmc)) || undefined;
    // tsy 是 HTML 片段（页面 #fcontent 的渲染内容）→ 纯文本
    const bodyText = htmlFragmentText(textOf(data.tsy));
    const publishedAt = normalizeDateText(textOf(data.ksrq)) ?? undefined;
    const deadlineAt = normalizeDateText(textOf(data.jsrq)) ?? undefined;

    if (!title && !bodyText && !publishedAt && !deadlineAt) return null;
    // 附件见文件头「已知取舍」：接口无附件字段，留空（不覆盖列表层的空数组）
    return { title, publishedAt, deadlineAt, bodyText };
  },
};
