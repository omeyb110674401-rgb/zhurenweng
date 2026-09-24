import { createMailerPort } from '../../src/lib/ports.ts';
import { envInt } from '../../src/lib/env-int.ts';
import { mailerReady, mailerUnavailableReason } from '../../src/lib/mailer-availability.ts';
import {
  MAX_NOTICES_PER_EMAIL,
  buildNewNoticesEmail,
} from '../../src/lib/mail.ts';
import {
  listNotifiedPairs,
  listNoticesFirstSeenSince,
  recordNoticeNotifications,
} from '../../src/db/repo/notifications.ts';
import { listActiveSubscriptions } from '../../src/db/repo/subscriptions.ts';
import { matchesSubscriptionRules } from '../../src/lib/subscription.ts';
import type { NoticeRecord } from '../../src/db/types.ts';
import type { Job, JobContext } from '../registry.ts';

/**
 * 新公示通知任务（issue #60 第 3 刀）：让订阅者在公示**刚收录**时就收到，而不是只剩 3 天才被提醒。
 *
 * 这一刀补的是漏斗上最大的一个洞：截止提醒只在 d7 / d3 两个点发信，
 * 一个 30 天窗口的公示如果对订阅者有用，他往往在发布当天就想知道 ——
 * 「读者为什么不回来」的正面答案不是把摘要做得更好，而是**主动去找他**。
 *
 * 三条口径：
 * 1. **一人一封汇总**（不是一条一封）：个人 SMTP 有日发信上限，而"新增三条=三封信"
 *    是退订的经典诱因；
 * 2. **去重键是（条目 × 订阅）**，写在信真的发出去之后（先记后发 = 把没送到说成已通知，
 *    那条公示就永远进不了这个人的收件箱）；
 * 3. **没列进本信的溢出条目不写标记**，下一轮还会带来 —— 否则用户永远看不到它们，
 *    而我们以为通知过了。
 */

/** 通知回看窗口（天）：只通知这段时间内首次收录的条目。 */
const LOOKBACK_DAYS = envInt('NOTIFY_LOOKBACK_DAYS', 7, { min: 1, max: 90 });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 回看窗口的起点（ISO）。`first_seen_at` 为 NULL 的存量条目由仓库层的 isNotNull 挡掉。 */
function sinceOf(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/**
 * 这个订阅本轮要收的那批条目（纯函数，便于单测）。
 *
 * 上限截断在这里做，且**只截进信里的部分**：`overflow` 是把没列进去的条数带出去，
 * 用于邮件里那句"另有 N 条会在下一封里发出"。
 */
export function pickNoticesForSubscription(
  subscription: {
    keywords: string[];
    categories: string[];
    agencies: string[];
    scope: string;
  },
  candidates: NoticeRecord[],
  notified: Set<string>,
  subscriptionId: string,
  maxPerEmail = MAX_NOTICES_PER_EMAIL,
): { picked: NoticeRecord[]; overflow: number } {
  const matched = candidates.filter(
    (notice) =>
      !notified.has(`${notice.id}\u0000${subscriptionId}`)
      && matchesSubscriptionRules(subscription as never, notice),
  );
  return {
    picked: matched.slice(0, maxPerEmail),
    overflow: Math.max(0, matched.length - maxPerEmail),
  };
}

export const notifyNewNoticesJob: Job = {
  name: 'notify-new-notices',
  description:
    '每轮把新收录且命中订阅规则的公示汇总成一封邮件发给每位已确认订阅者（条目×订阅去重）',
  async run(ctx: JobContext): Promise<void> {
    if (!mailerReady()) {
      // 与摘要任务同一处理（issue #22）：配置缺失不该每轮报"任务失败"
      ctx.logger(`邮件端口未配置，本轮跳过新公示通知：${mailerUnavailableReason() ?? '原因未知'}`);
      return;
    }
    const subscriptions = await listActiveSubscriptions();
    if (subscriptions.length === 0) {
      ctx.logger('没有可通知的订阅（需已确认且未退订），新公示通知跳过');
      return;
    }
    const now = ctx.now();
    const candidates = await listNoticesFirstSeenSince(sinceOf(now, LOOKBACK_DAYS));
    if (candidates.length === 0) {
      ctx.logger(`回看 ${LOOKBACK_DAYS} 天内无新收录条目，跳过新公示通知`);
      return;
    }
    const notified = await listNotifiedPairs(candidates.map((notice) => notice.id));
    const mailer = createMailerPort();
    let sentSubscribers = 0;
    let skippedAllNotified = 0;
    let failures = 0;

    for (const subscription of subscriptions) {
      const { picked, overflow } = pickNoticesForSubscription(
        subscription,
        candidates,
        notified,
        subscription.id,
      );
      if (picked.length === 0) {
        skippedAllNotified += 1;
        continue;
      }
      try {
        await mailer.send(
          buildNewNoticesEmail({
            email: subscription.email,
            notices: picked,
            overflowCount: overflow,
            unsubscribeToken: subscription.unsubscribeToken,
            now: now.toISOString(),
          }),
        );
      } catch (error) {
        // 发不出去就不写去重标记：下一轮这批条目仍然待通知
        failures += 1;
        ctx.logger(`新公示通知发送失败 subscription=${subscription.email}：${errorMessage(error)}`);
        continue;
      }
      await recordNoticeNotifications({
        subscriptionId: subscription.id,
        noticeIds: picked.map((notice) => notice.id),
        sentAt: now.toISOString(),
      });
      sentSubscribers += 1;
      ctx.logger(
        `新公示通知已发送 to=${subscription.email} 条数=${picked.length}${overflow > 0 ? ` 溢出未列=${overflow}` : ''}`,
      );
    }
    ctx.logger(
      `新公示通知任务完成：候选条目 ${candidates.length}，订阅 ${subscriptions.length}，发送 ${sentSubscribers} 封，无需发送 ${skippedAllNotified} 人，失败 ${failures} 次`,
    );
  },
};
