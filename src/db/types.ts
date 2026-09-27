import type { GenreEvidenceKind, NoticeGenre } from '../lib/notice-genre.ts';
import type { NoticeAudience } from '../lib/audience.ts';

/**
 * 中立的领域类型 —— 仓库层（src/db/repo）对外的数据形状，
 * 与具体数据库方言解耦。页面与业务代码只依赖这些类型。
 */

/** 公示状态（PRD：征求意见中 / 已截止 / 已出结果） */
export type NoticeStatus = 'open' | 'closed' | 'resulted';

/** 公示附件（官方原文页面上的草案文本、说明等文件） */
export interface NoticeAttachment {
  /** 展示名（含扩展名，如「xxx（草案征求意见稿）.pdf」） */
  name: string;
  /** 绝对 URL */
  url: string;
}

/**
 * 附件抽取状态（issue #57）。终态与待处理分开看：
 * 除 `pending` 外都是本轮已给出结论的状态。
 *
 * `blocked`（源站拒绝）与 `not_a_file`（返回 HTML / CDN 拦截页）刻意不隐藏页面上的
 * 附件链接 —— 我们机房的失败不代表用户的失败，这是 #35 定下的红线。
 */
export type AttachmentExtractStatus =
  | 'pending'
  | 'ok'
  | 'blocked'
  | 'not_a_file'
  | 'too_large'
  | 'no_draft_text'
  | 'scanned_no_text'
  | 'unsupported_container'
  | 'error'
  | 'gone';

/** 附件类型，按文件头 magic 判定（扩展名不可靠：264/340 个附件名根本没有扩展名） */
export type AttachmentKind = 'pdf' | 'docx' | 'doc' | 'other';

/** `notice_attachments` 一行（附件抽取状态与本文，issue #57） */
export interface NoticeAttachmentRecord {
  noticeId: string;
  /** 附件绝对 URL，与 notice_id 一起构成主键 */
  url: string;
  name: string | null;
  status: AttachmentExtractStatus;
  kind: AttachmentKind | null;
  bytes: number | null;
  /** sha256(body)：跨轮缓存键，命中即不再发请求 */
  contentHash: string | null;
  charCount: number | null;
  extractedText: string | null;
  error: string | null;
  /** 本轮摘要是否用到了它 */
  fedToSummary: boolean;
  attemptCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastFetchAt: string | null;
}

/** 公示条目（PRD「数据模型」中的核心实体） */
export interface NoticeRecord {
  id: string;
  sourceId: string;
  title: string;
  /** 发布机关 */
  agency: string;
  /** 官方原文 URL（唯一键，防重复入库） */
  url: string;
  /** ISO 8601 日期字符串 */
  publishedAt: string | null;
  /** 截止日期，ISO 8601 */
  deadlineAt: string | null;
  status: NoticeStatus;
  /** 领域标签 */
  categoryTags: string[];
  /** 正文纯文本 */
  bodyText: string | null;
  /** 附件清单 */
  attachments: NoticeAttachment[];
  /** 结构化 AI 摘要（形状见 src/lib/ports.ts 的 StructuredSummary） */
  aiSummary: unknown;
  /** 摘要模型名与版本 */
  summaryModel: string | null;
  /** 抓取时间，ISO 8601（每轮 upsert 都会覆盖，不是"首次收录"） */
  fetchedAt: string;
  /**
   * 首次收录时间（issue #60 第 3 刀）：建行时写入、更新不再覆盖。
   * null = 本次上线之前就存在 ⇒ 新公示通知一律不覆盖它（不回填存量是有意为之）。
   */
  firstSeenAt: string | null;
  /**
   * 体裁（issue #76）：摘要管线按它选模板。null = 本列上线前的存量、没判定过；
   * 'unknown' 才是「判过了但标题与附件都没线索」。两者都显示「未判定」，但只有前者会被回填脚本再扫。
   */
  genre: NoticeGenre | null;
  /** 凭什么这么判（一句人话，后台展示） */
  genreBasis: string | null;
  /** 判定用的证据种类（弱证据不覆盖强证据） */
  genreEvidence: GenreEvidenceKind | null;
  /**
   * 受众面（issue #83）：这条公示"该谁来看、该谁去提意见"。与领域标签正交 ——
   * 领域答"关于什么事"，受众面答"谁该看"。null = 本列上线前的存量、没判定过；
   * 'unknown' 才是「判过了但没线索」，两者都显示「未判定」但只有前者待回填。
   */
  audience: NoticeAudience | null;
  /** 凭什么这么判（一句人话，后台与审计脚本展示） */
  audienceBasis: string | null;
  /** 出站提意点击数（北极星指标） */
  outboundClicks: number;
  /** 版本链（issue #10）：上一轮版本条目 id；首版 / 未关联为 null */
  versionOf: string | null;
  /** 版本轮次序号（1 = 首轮公示）；未关联为 null */
  versionSeq: number | null;
}

/** 源（抓取配置与健康状态） */
export interface SourceRecord {
  id: string;
  name: string;
  adapterType: string;
  healthy: boolean;
  /** 连续失败轮数（issue #58）：判「异常」的门槛计数，成功归零 */
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  /**
   * **当前**故障态的错误信息（issue #12；issue #58 起抓取成功即清空）。
   * null = 当前没有故障。
   */
  lastErrorMessage: string | null;
  /** 最近一次错误时间，ISO 8601 */
  lastErrorAt: string | null;
  /** false = 已停用（抓取任务跳过该源） */
  enabled: boolean;
}

/** 提醒档（issue #7）：截止前 7 天 / 3 天各一次 */
export type ReminderStage = 'd7' | 'd3';

/**
 * 邮件订阅（double opt-in，issue #7）。
 * 未确认（confirmed=false）的订阅绝不接收任何提醒；退订后不再发送任何邮件。
 */
/**
 * 订阅范围（issue #60 第 2 刀）。`'all'` 必须是用户显式选的 ——
 * 「规则为空」不代表"什么都要"，更常见的是漏填。
 */
export type SubscriptionScope = 'rules' | 'all';

/** 一份订阅规则（issue #60 第 4 刀）：正式列与待确认列共用同一个形状。 */
export interface SubscriptionRules {
  keywords: string[];
  categories: string[];
  agencies: string[];
  scope: SubscriptionScope;
  /**
   * 受众面收窄条件（issue #84）：空数组 = 不限。取值只有 `public` / `sector` ——
   * 「未判定」刻意不能订（那不是一个人会有的意图：没人会说"请把你们没归好类的发给我"）。
   */
  audiences: NoticeAudience[];
}

export interface SubscriptionRecord {
  id: string;
  /** 仅存储订阅邮箱（PRD 合规姿态），统一小写 */
  email: string;
  /** 关键词规则：命中条目标题或正文 */
  keywords: string[];
  /** 领域规则：命中条目领域标签 */
  categories: string[];
  /** 发布机关规则（issue #60 第 2 刀）：归一后的机关名，逐个精确相等匹配参与机关 */
  agencies: string[];
  /** 订阅范围（issue #60）：'rules' 只收命中条件的；'all' 全部新公示 */
  scope: SubscriptionScope;
  /**
   * 受众面收窄条件（issue #84）：空数组 = 不限（本列上线前的订阅全在这里，
   * 行为与旧版逐条一致）；非空时与上面三项是 AND，且对 `scope='all'` 同样生效 ——
   * "全部新公示，但我只看公众广域"必须是那个意思，否则这一栏就是在骗人。
   */
  audiences: NoticeAudience[];
  /**
   * 待确认的规则改动（issue #60 第 4 刀）：非 null 表示"这个人提交过修改但还没确认"。
   * 确认前，提醒与通知仍按上面的正式规则发。
   */
  pending: SubscriptionRules | null;
  /** false = 待确认 / true = 已确认 */
  confirmed: boolean;
  /** 确认令牌（确认邮件链接） */
  confirmToken: string;
  /** 一键退订令牌（所有邮件底部链接） */
  unsubscribeToken: string;
  confirmedAt: string | null;
  unsubscribedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 安全解析 JSON 列（解析失败返回 null，不抛出）。 */
export function safeParseJson(text: string | null): unknown {
  if (text === null || text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** 安全解析 JSON 数组列（解析失败返回空数组）。 */
export function safeParseJsonArray(text: string): string[] {
  const parsed = safeParseJson(text);
  return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
}
