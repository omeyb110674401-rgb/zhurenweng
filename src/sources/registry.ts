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
  /** 官方原文 URL（绝对地址） */
  url: string;
  publishedAt: string | null;
  deadlineAt: string | null;
  bodyText: string | null;
}

export interface SourceAdapter {
  /** 源 ID，与 fixtures/<source>/ 目录名一致，如 npc-law-drafts */
  id: string;
  /** 展示名 */
  name: string;
  /** 入口列表页 URL（测试环境可指向 fixture 源站地址） */
  listUrl: string;
  /** 解析列表页 HTML，返回条目列表 */
  parseList(html: string, baseUrl: string): Promise<NormalizedNotice[]>;
}

/** 注册表：所有源适配器在此登记，调度器按此数组驱动。 */
export const sourceAdapters: SourceAdapter[] = [];
