import type { NormalizedNotice, ParsedDetail, SourceAdapter } from '../registry.ts';
import type { NoticeAttachment } from '../../db/types.ts';
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
 * - 缓解：只聚合官方公开信息、不携带任何凭据/Cookie、不基于该内容做任何鉴权或写操作；
 *   正文入库前按**内容哈希**判重（同一份不再重下）。
 * - ⚠️ **附件也是 http**（issue #86 第十八节起，开关打开时会下草案 PDF，实测那条 41 MB）：
 *   从前这里写的是"附件只记录链接不下载正文"，现在不再是事实。取舍是：站点对浏览器也只
 *   提供 http 入口（读者点开「官方原文」走的是同一个明文通道），我们不为自己的抓取设一套
 *   更宽松、也不设一套更严苛的标准；真正需要防的是"摘要里出现源站没有的话"，而那一层由
 *   摘要侧的**逐字反查**兜着（引用与出处对不上就丢弃那一条）。若站点日后恢复 https，
 *   这条风险一并消失。
 * - 若站点日后恢复 https（浏览器可正常打开即为信号），把本文件的 `http://` 换成
 *   `https://` 即可，无需其他改动。
 *
 * ## 已知取舍
 * 接口不提供发布机关字段（人工页也没有「发布机关：」文本），机关取栏目主办方常量。
 *
 * 草案电子文档（`/flcaw/flca/<lid>/attachment.pdf`）在 issue #86 第十八节接上了，
 * 由 `NPC_DRAFT_ATTACHMENTS` 这个**缺省关**的开关控制，实测依据见下方常量处的注释。
 * 文件名仍然来自官方接口（`/fjxx/` 的 `fileName`），**不臆造**。
 */

/** 列表接口（进行中征求意见）。生产地址写死 http（见上方 TLS 处置）。 */
const LIST_URL = 'http://www.npc.gov.cn/flcaw/flca-list?flag=0&type=0&page=1&per_page=100';
/** 条目人工页文件名（相对列表接口地址解析，测试环境自动指向 fixture 快照）。 */
const DETAIL_PAGE_FILE = 'userIndex.html';
/** 详情内容接口目录：<flcaw>/flca/<lid>/info/ */
const DETAIL_API_DIR = 'flca';
/**
 * 附件清单接口目录：<flcaw>/flca/<lid>/fjxx/（issue #86 第十八节实测）。
 *
 * 返回一个 JSON 对象（实测 599–652 字节，五条草案各一份），带真文件名与声明大小：
 * `{"fileName":"企业破产法（修订草案二次审议稿）.PDF","size":"524947","path":"/flca/5390….PDF",…}`。
 * **只有 `fileName` 有用**：同一份 JSON 里的 `path`（`/flca/<hash>.PDF`）实测对我们
 * 机房 IP 一律 **404 + application/json**（五条全试过），而 `attachment.pdf` 五条全 200
 * 且字节数与 JSON 里声明的 `size` **逐条相同**（390,510 / 444,495 / 524,947 / 1,334,899 /
 * 43,254,307）—— 所以地址写 `attachment.pdf`，大小只用来核对。
 */
const ATTACHMENT_LIST_DIR = 'fjxx';
/** 草案电子文档（实测 200 / application/pdf，`%PDF-` 头）。 */
const ATTACHMENT_FILE = 'attachment.pdf';
/**
 * 一份草案 PDF 的按源预算（issue #86 §17.5 + §18）。
 *
 * 实测：五条进行中的法律草案里四份是 0.4–1.3 MB，一份（道路交通安全法修订草案）
 * 是 **43,254,307 字节**；同类文件从机房下载约 0.9–1.1 MB/s ⇒ 一条约 40 秒。
 * 全局缺省是 4 MB / 15 秒，两条都不够（只抬一条的后果见 SourceFetchOptions 的注释），
 * 所以这里按源声明 64 MB / 120 秒：对四份小草案毫无影响，对那份 41 MB 的留出余量。
 */
const ATTACHMENT_BUDGET = { maxBytes: 64 * 1024 * 1024, timeoutMs: 120_000 } as const;

/**
 * 草案电子文档开关：`off`（缺省）/ `on`。
 *
 * 为什么缺省关：打开它意味着**开始按 41 MB 一档拉文件**（那是抓取侧的产品决定，
 * 见 issue #86 §17.3），所以"部署代码"与"开始拉文件"是两次独立的决定 —— 代码先上，
 * 开关在 `.env` 里单独打开。三处缺省（代码 / `.env.example` / compose 回退值）
 * 必须同值，由 `tests/unit/deploy-env-contract.test.mjs` 守。
 *
 * 写错当场抛错（与 `attachmentMode()` 同一取舍）：`NPC_DRAFT_ATTACHMENT=on` 这种笔误
 * 若静默当成 off，会得到"开关打开了但一条附件都没声明"的错误结论 —— 而**没有请求
 * 发出去**这件事，在源站日志和我们的网络日志里都看不见。
 */
export function npcDraftAttachmentsEnabled(): boolean {
  const raw = process.env.NPC_DRAFT_ATTACHMENTS?.trim();
  // 空串当「未设置」：compose 用 `${NPC_DRAFT_ATTACHMENTS:-}` 形态传变量，留空会传空串
  const value = raw === undefined || raw === '' ? 'off' : raw.toLowerCase();
  if (value === 'off') return false;
  if (value === 'on') return true;
  throw new Error(
    `NPC_DRAFT_ATTACHMENTS 不是合法档位：「${raw ?? ''}」（应为 off / on，未设置时缺省 off）`,
  );
}


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
  /**
   * 本站接口比其它源慢一个量级（2026-09-23 线上实测：列表请求在 15s 全局预算下抛
   * `aborted due to timeout`），单独放宽到 30s。刻意**不**抬高全局缺省：那等于让
   * 其余九个源的每一跳都为这一个站多等一倍时间。
   */
  fetch: { timeoutMs: 30_000, attachmentBudget: ATTACHMENT_BUDGET },
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

  /**
   * 附件清单接口（issue #86 第十八节）：**只有开关打开时才返回地址** —— 关着的时候
   * 一个请求都不发（这正是"缺省关"要保证的事：部署代码不等于开始拉 41 MB 的文件）。
   */
  attachmentListUrl(notice: NormalizedNotice): string | null {
    if (!npcDraftAttachmentsEnabled()) return null;
    const lid = lidFromDetailUrl(notice.url);
    if (!lid) return null;
    return resolveUrl(
      `${DETAIL_API_DIR}/${encodeURIComponent(lid)}/${ATTACHMENT_LIST_DIR}/`,
      notice.url,
    );
  },

  /**
   * 解析 `/fjxx/` 的响应。判据只有一条：**有文件名才声明**。
   *
   * 文件名取官方的 `fileName`（不臆造、不用标题拼），地址取同目录下的 `attachment.pdf`
   * （实测五条全 200 且字节数与 `size` 逐条相同；JSON 里的 `path` 反而 404，见文件头）。
   * 接口返回空对象 / 错误页 / 没有 fileName 时返回空数组：宁可没有附件，也不要一个
   * 猜出来的文件名出现在页面的「出处」那一行。
   */
  parseAttachmentList(payload: string, pageUrl: string): NoticeAttachment[] {
    const data = parseJsonObject(payload);
    if (!data) return [];
    const name = normalizeWhitespace(textOf(data.fileName));
    if (name.length === 0) return [];
    const lid = lidFromDetailUrl(pageUrl);
    if (!lid) return [];
    const url = resolveUrl(
      `${DETAIL_API_DIR}/${encodeURIComponent(lid)}/${ATTACHMENT_FILE}`,
      pageUrl,
    );
    if (!url) return [];
    return [{ name, url }];
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
