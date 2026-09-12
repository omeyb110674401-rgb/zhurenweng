import { jobs, type JobContext } from './registry.ts';

/**
 * worker 进程入口（占位实现，issue #2）。
 * 只负责按注册表调度：注册表为空时空转，不退出 —— 后续切片往
 * worker/registry.ts 的 jobs 数组登记任务即可，无需改本文件。
 *
 * 环境变量：
 * - WORKER_INTERVAL_MS：调度间隔，默认 60000；
 * - WORKER_ONCE=1：执行一轮后退出（本地验证 / 手动触发用）。
 */

const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 60000);
const runOnce = process.env.WORKER_ONCE === '1';

const logger = (message: string): void => {
  console.log(`[worker] ${new Date().toISOString()} ${message}`);
};

const ctx: JobContext = {
  logger,
  now: () => new Date(),
};

async function tick(): Promise<void> {
  if (jobs.length === 0) {
    logger('任务注册表为空，本轮无任务可执行');
    return;
  }
  for (const job of jobs) {
    try {
      logger(`执行任务 ${job.name}`);
      await job.run(ctx);
    } catch (error) {
      logger(`任务 ${job.name} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const names = jobs.map((job) => job.name);

if (runOnce) {
  logger(`单轮模式：已注册任务 [${names.join(', ') || '（无）'}]`);
  await tick();
  // 不调用 process.exit(0)：Windows 上强退会与尚未关闭的句柄（HTTP keep-alive
  // 连接等）竞争，触发 libuv 断言使退出码非 0。置退出码后由事件循环自然排空退出。
  logger('单轮模式完成，退出');
} else {
  logger(`worker 启动：已注册 ${jobs.length} 个任务 [${names.join(', ') || '（无）'}]，间隔 ${intervalMs}ms`);
  await tick();
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger(`收到 ${signal}，停止调度并退出`);
      clearInterval(timer);
      process.exit(0);
    });
  }
}
