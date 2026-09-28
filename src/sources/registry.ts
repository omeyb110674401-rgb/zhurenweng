import type { NoticeAttachment, NoticeStatus } from '../db/types.ts';
import { cacAdapter } from './adapters/cac.ts';
import { meeAdapter } from './adapters/mee.ts';
import { miitAdapter } from './adapters/miit.ts';
import { mohurdAdapter } from './adapters/mohurd.ts';
import { moeAdapter } from './adapters/moe.ts';
import { mojAdapter } from './adapters/moj.ts';
import { motAdapter } from './adapters/mot.ts';
import { ndrcAdapter } from './adapters/ndrc.ts';
import { npcLawDraftsAdapter } from './adapters/npc.ts';
import { samrAdapter } from './adapters/samr.ts';

/**
 * 源适配器注册表 —— 数据接入的唯一扩展点（PRD「源与适配器」）。
 *
 * 新增一个源 = 新增一个适配器模块并把它加入下面的 `sourceAdapters` 数组，
 * 调度器只遍历注册表，核心代码不因新增源而修改。
 * 适配器的端到端契约由 E2E 场景隐式定义：fixtures/<source>/ 下放页面快照，
 * 测试经本地 fixture 源站驱动适配器并从 HTTP 层断言结果。
 */

/** 适配器输出的标准化公示条目（入库前的中间形状） */
export interface NormalizedNotice {
  title: string;
  agency: string;
  /** 官方原文 URL（绝对地址，入库唯一键） */
  url: string;
  /** ISO 8601 日期（YYYY-MM-DD），未知为 null */
  publishedAt: string | null;
  /** 截止日期，ISO 8601 日期（YYYY-MM-DD），未知为 null */
  deadlineAt: string | null;
  /** 正文纯文本，列表层解析不到时由详情页补充 */
  bodyText: string | null;
  /** 附件清单（通常在详情页解析） */
  attachments: NoticeAttachment[];
  /**
   * 适配器已知领域标签（issue #9 适配器规则，可选）：源自身带有权威领域
   * 信息时由适配器直接给出；未提供时入库路径按关键词规则自动打标
   * （src/lib/categories.ts 的 deriveCategoryTags，抓取与手动补录共用）。
   */
  categoryTags?: string[];
  /**
   * 源自身标注的条目状态（可选）：多个部委栏目直接在标题或状态列里标注
   * 「进行中 / 已结束」（交通运输部 [进行中]、教育部 [已结束]、市场监管总局
   * 「(进行中)」），这是源给出的权威状态。抓取管线只在**截止日期解析不到**时
   * 采用它（截止日期是更精确的事实，见 crawl-notices 的 deriveStatus）。
   */
  status?: NoticeStatus;
}

/** 详情页解析结果：与列表层数据按字段合并（只覆盖解析出值的字段）。 */
export interface ParsedDetail {
  title?: string;
  agency?: string;
  publishedAt?: string | null;
  deadlineAt?: string | null;
  bodyText?: string | null;
  attachments?: NoticeAttachment[];
  /** 适配器已知领域标签（可选，见 NormalizedNotice.categoryTags） */
  categoryTags?: string[];
  /** 源自身标注的条目状态（可选，见 NormalizedNotice.status） */
  status?: NoticeStatus;
}

/**
 * 源级抓取选项（可选）：个别站点需要特殊处置，见各适配器注释里的实测依据。
 * 不设置时与全局 fetch 行为一致，不影响其他源。
 */
export interface SourceFetchOptions {
  /**
   * WAF cookie 挑战（司法部站点实测，2026-09-20）：首次请求返回 3xx + Set-Cookie，
   * 且 Location 指向同一地址；必须带上该 cookie 重放一次才能拿到 200 ——
   * 不带 cookie 时 fetch 的自动重定向会陷入自我循环。仅对本源生效。
   */
  cookieChallenge?: boolean;
  /**
   * 本源单次请求的超时预算（毫秒），未声明时用全局 `CRAWL_TIMEOUT_MS`。
   *
   * 为什么按源而不是全局放大：人大网的列表接口偶发比别的源慢一个量级（issue #58
   * 线上实测：`The operation was aborted due to timeout`），把全局值抬到能容下它，
   * 等于让其余九个源的每一轮都多等那么久 —— 慢是这一个站的属性，不该由全站买单。
   */
  timeoutMs?: number;
  /**
   * 附件预算（可选，按源）：个别源的附件与其余源不是一个量级时在此声明。
   *
   * 为什么字节与时间必须**成对**声明：只抬 `maxBytes` 而不抬超时，下载仍然会在全局
   * 抓取超时（缺省 15s）上被掐断 —— 结局是一条 `error`（"下载失败"），重试三次后停住，
   * 事后看起来像"这个文件坏了"，而不是"这个文件的预算没配对"。
   *
   * 为什么不直接抬全局：`ATTACHMENT_MAX_BYTES`（缺省 4 MB）与 `CRAWL_TIMEOUT_MS`
   * 是所有源共同的预算，为一个站把上限抬到 64 MB，等于让另外九个源也能拉 64 MB ——
   * 与上面 `timeoutMs` 是同一条道理。实测依据见 `src/sources/adapters/npc.ts`。
   */
  attachmentBudget?: {
    /** 单个附件的下载上限（字节），未声明时用 `ATTACHMENT_MAX_BYTES` */
    maxBytes?: number;
    /** 单个附件的下载超时（毫秒），未声明时用 `CRAWL_TIMEOUT_MS` */
    timeoutMs?: number;
  };
}

export interface SourceAdapter {
  /** 源 ID，与 fixtures/<source>/ 目录名一致，如 npc */
  id: string;
  /** 展示名 */
  name: string;
  /** 入口列表页 URL（生产地址；测试经 SOURCES_FIXTURE_BASE 重写为 fixture 源站地址） */
  listUrl: string;
  /**
   * fixture 列表快照文件名（默认 list.html）。列表本身是 JSON 接口的源用 list.json
   * （fixture 源站对 .json 与 .html 同样做日期令牌替换，并按 JSON 提供内容类型）。
   */
  listFixturePath?: string;
  /** 抓取选项（默认无，见 SourceFetchOptions） */
  fetch?: SourceFetchOptions;
  /** 解析列表页 HTML（列表为接口的源即接口原文，如 JSON），返回条目列表 */
  parseList(html: string, baseUrl: string): Promise<NormalizedNotice[]>;
  /**
   * 解析条目详情页 HTML（可选）。抓取管线会对列表产出的每个条目抓取其
   * 详情内容 URL 并调用本方法，把结果按字段合并进标准化条目。
   */
  parseDetail?(html: string, pageUrl: string): Promise<ParsedDetail | null>;
  /**
   * 详情内容 URL（可选，默认 = 条目的原文 URL）：详情页由前端脚本渲染、正文另由
   * 数据接口提供时（全国人大网 flcaw 系统即如此），适配器在此返回该接口地址；
   * 抓取管线用它取详情内容，但仍以 notice.url（人工可读页面）作为入库唯一键
   * 与用户可见的「官方原文」链接。返回 null 表示回退到原文 URL。
   */
  detailContentUrl?(notice: NormalizedNotice): string | null;
  /**
   * 详情内容的**链式跳转**（可选，issue #20）：有些源的正文地址要一跳一跳才拿得到
   * （国家发展改革委实测：`sa.html#/<shortKey>` 前端渲染页 → access-url 接口拿到
   * 文章页地址 → 文章页只是空壳、正文在 getArticleDetail 接口里）。
   *
   * 抓取层取到 body 后调用本方法，返回值 = **下一跳地址**；返回 null 表示
   * 「当前 body 就是详情内容」，交给 parseDetail 解析。跳数有上限
   * （crawl-notices 的 MAX_DETAIL_HOPS），超过即视为该源结构异常并报错降级。
   *
   * 为什么由抓取层负责每一跳的请求、而不是适配器自己 fetch：① 源级传输处置
   * （`fetch.cookieChallenge`）、UA、超时、fixture 地址重写都集中在抓取层一处；
   * ② 适配器自己发请求会让 E2E 打到真实站点（ADR-0001）。因此适配器只做
   * 「从这一跳的 body / 地址推出下一跳地址」这件纯计算的事。
   *
   * 实现约定：下一跳地址应**相对当前跳的地址**推导（见 ndrc.ts 的 submissionRootOf），
   * 这样生产环境落在真实站点、E2E 里落在 fixture 目录内，同一份代码两条路都通。
   */
  resolveDetailUrl?(body: string, pageUrl: string): Promise<string | null> | string | null;
  /**
   * 附件清单接口（可选，issue #86 第十八节）：附件地址与**文件名**要另调一次接口才拿得到时，
   * 适配器在此返回该接口地址；抓取层取完详情内容后请求它，把响应交给 `parseAttachmentList`
   * 解析成附件清单并合并进条目。返回 null = 本源没有这种接口（或本轮的开关是关的）。
   *
   * 与 `detailContentUrl` 同一套路数：**请求由抓取层发**（源级传输处置 / UA / 超时 /
   * fixture 地址重写集中在一处，ADR-0001 也要求适配器不自己出网），适配器只做
   * 「给出地址」与「解析响应」这两件纯计算的事。
   *
   * 实现约定：地址应**相对 notice.url 推导**（见 npc.ts 的 fjxxUrlFor），这样生产环境落在
   * 真实站点、E2E 里落在 fixture 目录内，同一份代码两条路都通。
   */
  attachmentListUrl?(notice: NormalizedNotice): string | null;
  /**
   * 解析附件清单接口的响应（与 `attachmentListUrl` 成对出现）。返回空数组 = 这一轮没有
   * 声明任何附件（例如接口里没有文件名）—— **不要臆造文件名**，那正是本源当年不抓的理由。
   */
  parseAttachmentList?(
    payload: string,
    pageUrl: string,
  ): NoticeAttachment[] | Promise<NoticeAttachment[]>;
}

/**
 * 注册表：所有源适配器在此登记，调度器按此数组驱动。
 *
 * 当前 10 个源（PRD M1 源清单已全部接入：issue #28 补住房城乡建设部、issue #29 补国家网信办）：
 * 全国人大 / 司法部 / 生态环境部（M1 三源）+ 交通运输部 / 市场监管总局 /
 * 工业和信息化部 / 教育部 / 国家发展改革委（M2 扩源）+ 住房城乡建设部 / 国家网信办。
 *
 * ## 已评估但未接入的源（附实测依据，避免后人重复踩）
 *
 * - **中国政府网「意见征集」**：栏目已下线（见 mee.ts 文件头的实测记录）。
 * - **国务院部门其它栏目**：生态环境部、交通运输部等已接入的部委，其「征求意见」
 *   栏目是各自站点里唯一在运营的征求意见入口；其余部委（如财政部、卫健委）
 *   未逐个排查，按 PRD 属后续扩展。
 *
 * ## 接入留档：栏目入口不在首页导航时怎么办（issue #29 网信办）
 *
 * 网信办的征求意见条目挂在「互动服务 → 网信@你」，首页导航里没有入口，早先按
 * 「首页导航 + 常见路径」探测得到的是「候选路径全 404」的错误结论。教训：政府站点的
 * 征求意见栏目常挂在**互动 / 交流类二级栏目**下（互动服务 / 政民互动 / 公众参与），
 * 排查顺序应是「全站链接扫描（含首页各处 widget 的 href）→ 逐层进入二级栏目」，
 * 而不是只试 /zcfg/、/xxfb/ 这类猜测路径。
 */
export const sourceAdapters: SourceAdapter[] = [
  npcLawDraftsAdapter,
  mojAdapter,
  meeAdapter,
  motAdapter,
  samrAdapter,
  miitAdapter,
  moeAdapter,
  ndrcAdapter,
  mohurdAdapter,
  cacAdapter,
];
