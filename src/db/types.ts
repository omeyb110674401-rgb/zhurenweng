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
  /** 抓取时间，ISO 8601 */
  fetchedAt: string;
  /** 出站提意点击数（北极星指标） */
  outboundClicks: number;
}

/** 源（抓取配置与健康状态） */
export interface SourceRecord {
  id: string;
  name: string;
  adapterType: string;
  scheduleConfig: Record<string, unknown>;
  healthy: boolean;
  lastSuccessAt: string | null;
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
