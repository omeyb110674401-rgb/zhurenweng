import { and, eq } from 'drizzle-orm';
import { getDb } from '../client.ts';
import { alertSends } from '../schema/sqlite.ts';

/**
 * 任务失败告警仓库（issue #12）：告警发送去重标记。
 *
 * 去重键 = 本地日历日 × 任务名 × 源（alert_sends 的复合主键）——
 * 同一天同一源同一任务类型只发一封告警邮件，重复失败不重复轰炸；
 * 落表使去重在 worker 重启后依然有效。
 * 任务级失败（与具体源无关）sourceId 传空字符串。
 */

/** 该日 × 任务 × 源是否已发送过告警。 */
export async function hasAlertSend(
  alertDate: string,
  jobName: string,
  sourceId: string,
): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .select({ jobName: alertSends.jobName })
    .from(alertSends)
    .where(
      and(
        eq(alertSends.alertDate, alertDate),
        eq(alertSends.jobName, jobName),
        eq(alertSends.sourceId, sourceId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** 记录告警发送标记（邮件发送成功后调用）；复合主键冲突时静默忽略，保证幂等。 */
export async function recordAlertSend(
  alertDate: string,
  jobName: string,
  sourceId: string,
  sentAt: string,
): Promise<void> {
  const db = await getDb();
  await db
    .insert(alertSends)
    .values({ alertDate, jobName, sourceId, sentAt })
    .onConflictDoNothing();
}
