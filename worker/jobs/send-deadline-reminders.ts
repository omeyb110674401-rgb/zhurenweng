import { daysUntil } from '../../src/lib/dates.ts';
import { buildReminderEmail } from '../../src/lib/mail.ts';
import { createMailerPort } from '../../src/lib/ports.ts';
import { matchesSubscriptionRules } from '../../src/lib/subscription.ts';
import {
  hasReminderSend,
  listOpenNoticesWithDeadline,
  recordReminderSend,
} from '../../src/db/repo/reminders.ts';
import { listActiveSubscriptions } from '../../src/db/repo/subscriptions.ts';
import type { ReminderStage } from '../../src/db/types.ts';
import type { Job, JobContext } from '../registry.ts';

/**
 * 截止提醒任务（issue #7）：每日计算截止日期恰为今天 + 7 天 / 今天 + 3 天的
 * 「征求意见中」条目，与每个已确认订阅（未退订）的规则匹配
 * （关键词命中标题 / 正文或领域命中标签），发送提醒邮件。
 *
 * 触发时机与内容（AC）：提醒邮件含条目标题、剩余天数、截止日期、站内详情
 * 链接与官方原文提意链接；发送成功后写入 reminder_sends 去重标记
 * （条目 × 档 × 订阅），同一条目同一档对同一订阅只发一次，重复运行不重发。
 *
 * 每日调度由 worker 主循环的 WORKER_INTERVAL_MS 控制（生产 compose 设为每日），
 * WORKER_ONCE=1 可单轮运行；邮件经 MAILER_PROVIDER 注入（测试走 stub）。
 */

const REMINDER_DAYS: readonly { days: number; stage: ReminderStage }[] = [
  { days: 7, stage: 'd7' },
  { days: 3, stage: 'd3' },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const sendDeadlineRemindersJob: Job = {
  name: 'send-deadline-reminders',
  description:
    '每日向已确认订阅发送截止提醒（截止前 7 天 / 3 天各一档，按条目×档×订阅去重）',
  async run(ctx: JobContext): Promise<void> {
    const now = ctx.now();

    const subscriptions = await listActiveSubscriptions();
    if (subscriptions.length === 0) {
      ctx.logger('无已确认订阅，截止提醒任务跳过');
      return;
    }

    const notices = await listOpenNoticesWithDeadline();
    const mailer = createMailerPort();
    let sent = 0;
    let skippedDuplicates = 0;

    for (const notice of notices) {
      const days = daysUntil(notice.deadlineAt, now);
      if (days === null) continue;
      const stage = REMINDER_DAYS.find((entry) => entry.days === days);
      if (stage === undefined) continue;

      for (const subscription of subscriptions) {
        if (!matchesSubscriptionRules(subscription, notice)) continue;
        if (await hasReminderSend(notice.id, subscription.id, stage.stage)) {
          skippedDuplicates += 1;
          continue;
        }
        try {
          await mailer.send(
            buildReminderEmail({
              email: subscription.email,
              notice,
              days,
              stage: stage.stage,
              unsubscribeToken: subscription.unsubscribeToken,
            }),
          );
        } catch (error) {
          // 单封失败不中断整轮：不写去重标记，下一轮重试
          ctx.logger(
            `提醒邮件发送失败 notice=${notice.id} subscription=${subscription.email}：${errorMessage(error)}`,
          );
          continue;
        }
        await recordReminderSend(notice.id, subscription.id, stage.stage, now.toISOString());
        sent += 1;
        ctx.logger(
          `截止提醒已发送 stage=${stage.stage} 剩余=${days}天 notice=${notice.id} to=${subscription.email}`,
        );
      }
    }

    ctx.logger(
      `截止提醒任务完成：候选条目 ${notices.length}，订阅 ${subscriptions.length}，发送 ${sent} 封，去重跳过 ${skippedDuplicates} 次`,
    );
  },
};
