import { daysUntil } from '../../src/lib/dates.ts';
import { errorMessage } from '../../src/lib/errors.ts';
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

/**
 * 档位判定按**窗口 + 已发标记**，不按「剩余天数正好等于 7 / 3」。
 *
 * 旧写法 `days === entry.days` 有个静默的漏发：调度是每日一轮，只要那一天任务没跑成
 * （容器重启、发布窗口错开、源站拖垮整轮），条目就从「剩 8 天」直接跳到「剩 6 天」，
 * 7 天档**永远不会再命中** —— 用户少收一封提醒，而日志上看不出任何异常。
 * 改成「已到该档且该档尚未发过」之后，漏掉的那一档会在下一轮补发一次；
 * 去重键（条目 × 订阅 × 档）仍然保证每条公示每档至多一封，所以补发不会变成重发。
 *
 * 两档都命中时取**更靠前的那档**（先 7 后 3），于是每轮每人每条至多一封；
 * 「本轮该发哪一档」必须**按订阅**判 —— 同一条目上甲可能早已收到 7 天档、乙是中途才订阅的。
 *
 * `days < 0` 必须挡掉：库列 `status` 是抓取口径的缓存（issue #43），已过期但还没被
 * 下一轮抓取改口的条目仍是 `open`，按窗口判定会把「已过截止」的条目算成「该发」。
 *
 * 返回值里的 `allSent` 表示"到档都已发过"，用于区分跳过是幂等还是没到 —— 日志口径要准。
 */
export async function pickDueStage(
  remainingDays: number,
  isSent: (stage: ReminderStage) => Promise<boolean>,
): Promise<{ stage: { days: number; stage: ReminderStage } | undefined; allSent: boolean }> {
  if (remainingDays < 0) return { stage: undefined, allSent: false };
  const due = REMINDER_DAYS.filter((entry) => remainingDays <= entry.days);
  for (const entry of due) {
    if (!(await isSent(entry.stage))) return { stage: entry, allSent: false };
  }
  return { stage: undefined, allSent: due.length > 0 };
}

export const sendDeadlineRemindersJob: Job = {
  name: 'send-deadline-reminders',
  description:
    '每日向已确认订阅发送截止提醒（截止前 7 天 / 3 天各一档，按条目×档×订阅去重）',
  async run(ctx: JobContext): Promise<void> {
    const now = ctx.now();

    const subscriptions = await listActiveSubscriptions();
    if (subscriptions.length === 0) {
      ctx.logger('没有可通知的订阅（需已确认且未退订），截止提醒任务跳过');
      return;
    }

    const notices = await listOpenNoticesWithDeadline();
    const mailer = createMailerPort();
    let sent = 0;
    let skippedDuplicates = 0;

    for (const notice of notices) {
      const days = daysUntil(notice.deadlineAt, now);
      if (days === null) continue;

      for (const subscription of subscriptions) {
        if (!matchesSubscriptionRules(subscription, notice)) continue;
        // 本轮该发哪一档是**按订阅**判的：去重键里有订阅，同一条目上甲已收到 7 天档、
        // 乙可能还没收到（中途才订阅），所以不能按条目算一次给所有人用。
        const due = await pickDueStage(days, (candidate) =>
          hasReminderSend(notice.id, subscription.id, candidate),
        );
        const stage = due.stage;
        if (stage === undefined) {
          if (due.allSent) skippedDuplicates += 1;
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
