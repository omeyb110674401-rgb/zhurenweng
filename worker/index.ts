import { jobs, type JobContext } from './registry.ts';
import { sendTaskFailureAlert } from '../src/lib/alerts.ts';
import { envInt } from '../src/lib/env-int.ts';

/**
 * worker 进程入口（占位实现，issue #2）。
 * 只负责按注册表调度：注册表为空时空转，不退出 —— 后续切片往
 * worker/registry.ts 的 jobs 数组登记任务即可，无需改本文件。
 *
 * 环境变量：
 * - WORKER_INTERVAL_MS：调度间隔，默认 60000（非法值直接启动失败，见 lib/env-int.ts）；
 * - WORKER_ONCE=1：执行一轮后退出（本地验证 / 手动触发用）。
 * - WORKER_STOP_WAIT_MS：收到信号后等待在途轮次结束的上限，默认 30000（issue #51）。
 * - ALERT_EMAIL：任务失败告警收件邮箱（issue #12）；未配置则不发送。
 */

const intervalMs = envInt('WORKER_INTERVAL_MS', 60_000, { min: 1000 });
const stopWaitMs = envInt('WORKER_STOP_WAIT_MS', 30_000, { min: 0 });
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
      const message = error instanceof Error ? error.message : String(error);
      logger(`任务 ${job.name} 失败：${message}`);
      // 任务级失败告警（issue #12）：与具体源无关的整任务抛错；源内失败
      // （如单源抓取失败）在任务内部按源粒度告警，不会走到这里。
      await sendTaskFailureAlert({ jobName: job.name, sourceId: null, error: message, now: new Date(), log: logger });
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

  let running = false;
  let stopping = false;

  /**
   * 带重入保护的调度（issue #51）：一轮抓取可能远长于调度间隔（十个源 × 每条
   * 400ms 礼貌间隔，分钟级），而 `setInterval` 不会等上一轮结束 —— 没有守卫就会
   * 同时跑两轮：对政府站点是双倍请求速率（正是 issue #14 要避免的），对库是并发
   * 写同一批条目。
   */
  const guardedTick = async (): Promise<void> => {
    if (running || stopping) {
      logger('上一轮尚未结束，本轮跳过');
      return;
    }
    running = true;
    try {
      await tick();
    } catch (error) {
      // tick 内部已按任务粒度兜住错误，这里兜住「兜底本身失败」（如告警端口抛错）：
      // 否则会变成未处理拒绝把进程带走，重启后又跑同一轮 —— 重启循环。
      logger(
        `本轮调度异常（已忽略，等待下一轮）：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      running = false;
    }
  };

  await guardedTick();
  const timer = setInterval(() => {
    void guardedTick();
  }, intervalMs);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stopping) return;
      // 优雅退出（issue #51）：不打断在途的一轮抓取 —— 抓到一半退出会把源标成
      // 「本轮成功」但只写了一半条目（重启后启动即 tick，又会整轮重抓一遍）。
      // 先停止调度，再等在途轮次自然结束，最多等 stopWaitMs。
      stopping = true;
      clearInterval(timer);
      logger(`收到 ${signal}，停止调度；等待在途轮次结束（最多 ${stopWaitMs}ms）`);
      const deadline = Date.now() + stopWaitMs;
      const waiter = setInterval(() => {
        if (!running || Date.now() >= deadline) {
          clearInterval(waiter);
          logger(running ? '等待超时，仍有轮次在途，直接退出' : '在途轮次已结束，退出');
          process.exit(0);
        }
      }, 200);
    });
  }
}
