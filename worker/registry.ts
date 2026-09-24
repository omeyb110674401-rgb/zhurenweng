/**
 * worker 任务注册表 —— 后台任务（抓取管线、摘要、提醒、索引同步等）的唯一扩展点。
 *
 * 新增一个任务 = 新增一个任务模块并把它加入下面的 `jobs` 数组，
 * worker 主循环只遍历注册表，不因新增任务而修改。
 */

import { crawlNoticesJob } from './jobs/crawl-notices.ts';
import { extractAttachmentsJob } from './jobs/extract-attachments.ts';
import { summarizeNoticesJob } from './jobs/summarize-notices.ts';
import { sendDeadlineRemindersJob } from './jobs/send-deadline-reminders.ts';
import { notifyNewNoticesJob } from './jobs/notify-new-notices.ts';
import { reindexNoticesJob } from './jobs/reindex-notices.ts';

export interface JobContext {
  /** 统一前缀的日志函数 */
  readonly logger: (message: string) => void;
  /** 当前时间（便于测试注入时钟） */
  readonly now: () => Date;
}

export interface Job {
  /** 任务名，日志与告警使用 */
  name: string;
  description?: string;
  run(ctx: JobContext): Promise<void>;
}

/** 注册表：所有 worker 任务在此登记，主循环按此数组调度。 */
export const jobs: Job[] = [
  crawlNoticesJob,
  // 附件条文抽取（issue #57）排在摘要之前：摘要那一轮要把附件文本当输入，
  // 而附件表是跨轮存活的 —— 排在后面就等于摘要永远慢一轮。
  extractAttachmentsJob,
  summarizeNoticesJob,
  sendDeadlineRemindersJob,
  // 新公示通知（issue #60）排在提醒之后：两者都是"替读者盯着"，但截止提醒有时效底线，
  // 先保证它发出；通知用同一份匹配逻辑（matchesSubscriptionRules），不另写一套。
  notifyNewNoticesJob,
  // 检索索引全量重建（issue #8）注册在末位：每轮先抓取 / 摘要，最后重刷索引
  reindexNoticesJob,
];
