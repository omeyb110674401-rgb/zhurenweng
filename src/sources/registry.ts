import type { NoticeAttachment } from '../db/types.ts';
import { mojAdapter } from './adapters/moj.ts';
import { npcLawDraftsAdapter } from './adapters/npc.ts';

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
}

/** 详情页解析结果：与列表层数据按字段合并（只覆盖解析出值的字段）。 */
export interface ParsedDetail {
  title?: string;
  agency?: string;
  publishedAt?: string | null;
  deadlineAt?: string | null;
  bodyText?: string | null;
  attachments?: NoticeAttachment[];
}

export interface SourceAdapter {
  /** 源 ID，与 fixtures/<source>/ 目录名一致，如 npc */
  id: string;
  /** 展示名 */
  name: string;
  /** 入口列表页 URL（生产地址；测试经 SOURCES_FIXTURE_BASE 重写为 fixture 源站地址） */
  listUrl: string;
  /** 解析列表页 HTML，返回条目列表 */
  parseList(html: string, baseUrl: string): Promise<NormalizedNotice[]>;
  /**
   * 解析条目详情页 HTML（可选）。抓取管线会对列表产出的每个条目抓取其
   * 原文 URL 并调用本方法，把结果按字段合并进标准化条目。
   */
  parseDetail?(html: string, pageUrl: string): Promise<ParsedDetail | null>;
}

/** 注册表：所有源适配器在此登记，调度器按此数组驱动。 */
export const sourceAdapters: SourceAdapter[] = [npcLawDraftsAdapter, mojAdapter];
