/**
 * worker 任务注册表 —— 后台任务（抓取管线、摘要、提醒、索引同步等）的唯一扩展点。
 *
 * 新增一个任务 = 新增一个任务模块并把它加入下面的 `jobs` 数组，
 * worker 主循环只遍历注册表，不因新增任务而修改。
 */

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
export const jobs: Job[] = [];
