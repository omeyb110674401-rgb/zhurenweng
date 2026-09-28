import type { SourceAdapter } from './registry.ts';

/**
 * 一个源的附件预算（issue #86 第十八节）。
 *
 * 为什么要有这一层：单个附件的上限与超时是**全站预算**（`ATTACHMENT_MAX_BYTES` /
 * `CRAWL_TIMEOUT_MS`），而人大网的草案 PDF 实测有一条 43,254,307 字节、下载约 40 秒 ——
 * 全局的 4 MB / 15 秒对它是两处都会踩的硬墙。把全局抬到能容下它，等于让另外九个源
 * 也能拉 64 MB（与 `SourceFetchOptions.timeoutMs` 是同一条道理：大是那一个源的属性）。
 *
 * 这一层是纯函数、**不 Import 注册表**：适配器列表由调用方传进来（工作进程传真的，
 * 单测传假的），所以"按源取值"这件事可以单独钉死，不必拉起整个源注册表。
 */
export interface AttachmentBudget {
  /** 单个附件的下载上限（字节） */
  maxBytes: number;
  /** 单个附件的下载超时（毫秒） */
  timeoutMs: number;
  /**
   * `maxBytes` 是否来自**按源声明**。
   *
   * 这条不是装饰：超限时写给人看的原因必须说准是"这个源的上限"还是"全站上限"，
   * 否则一条 41 MB 的草案被拒之后，看日志的人会去改全局旋钮（而那个旋钮本来就该是 4 MB）。
   */
  maxBytesPerSource: boolean;
}

/** 按 `sourceId` 取该源的附件预算；未声明（或源不在注册表里）时用传入的全局值。 */
export function attachmentBudgetFor(input: {
  sourceId: string | null;
  adapters: readonly SourceAdapter[];
  globalMaxBytes: number;
  globalTimeoutMs: number;
}): AttachmentBudget {
  const declared =
    input.sourceId === null
      ? undefined
      : input.adapters.find((adapter) => adapter.id === input.sourceId)?.fetch?.attachmentBudget;
  return {
    maxBytes: declared?.maxBytes ?? input.globalMaxBytes,
    timeoutMs: declared?.timeoutMs ?? input.globalTimeoutMs,
    maxBytesPerSource: declared?.maxBytes !== undefined,
  };
}
