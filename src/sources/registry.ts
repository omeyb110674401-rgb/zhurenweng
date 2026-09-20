import type { NoticeAttachment, NoticeStatus } from '../db/types.ts';
import { meeAdapter } from './adapters/mee.ts';
import { miitAdapter } from './adapters/miit.ts';
import { moeAdapter } from './adapters/moe.ts';
import { mojAdapter } from './adapters/moj.ts';
import { motAdapter } from './adapters/mot.ts';
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
}

/**
 * 注册表：所有源适配器在此登记，调度器按此数组驱动。
 *
 * 当前 7 个源（PRD M2 要求部委直爬源扩至 8 个，第 8 个见下方「已评估但未接入」）：
 * 全国人大 / 司法部 / 生态环境部（M1 三源）+ 交通运输部 / 市场监管总局 /
 * 工业和信息化部 / 教育部（M2 扩源）。
 *
 * ## 已评估但未接入的源（附实测依据，避免后人重复踩）
 *
 * - **国家发展改革委**（`https://www.ndrc.gov.cn/hdjl/yjzq/`，栏目在运营、条目真实）：
 *   列表项链接全部是前端渲染页 `https://yyglxxbsgw.ndrc.gov.cn/sa.html#/<shortKey>`，
 *   正文要经**三跳**才能拿到：① `GET /public/submission-service/article/access-url?shortKey=<k>`
 *   返回 `{"data":"…/htmls/article/article.html?articleId=<uuid>"}`；② 该 article.html
 *   仍是空壳（`<h2></h2>`，正文由脚本填充）；③ 再用 articleId 取正文接口。
 *   现有适配器契约里 `detailContentUrl` 是同步单跳、且由抓取层负责请求，
 *   表达不了「先解析再请求」的链式跳转；且列表页**不含截止日期**（只有
 *   【进行中】/【已结束】标注），硬接会得到没有正文、没有截止日期的空条目。
 *   接入前需要给契约加一个「异步解析详情地址」的钩子（并让该跳转同样支持
 *   fixture 重写），属独立改动。
 * - **国家网信办**（www.cac.gov.cn）：首页导航无「征求意见」栏目入口，
 *   常见候选路径（/zcfg/、/xxfb/、/hdjl/yjzj/ 等）实测均 404。
 * - **中国政府网「意见征集」**：栏目已下线（见 mee.ts 文件头的实测记录）。
 */
export const sourceAdapters: SourceAdapter[] = [
  npcLawDraftsAdapter,
  mojAdapter,
  meeAdapter,
  motAdapter,
  samrAdapter,
  miitAdapter,
  moeAdapter,
];
