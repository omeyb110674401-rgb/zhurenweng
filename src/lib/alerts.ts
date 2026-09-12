import { localDateIso } from './dates.ts';
import { buildTaskFailureAlertEmail } from './mail.ts';
import { createMailerPort } from './ports.ts';
import { hasAlertSend, recordAlertSend } from '../db/repo/alerts.ts';
import { getSourceById } from '../db/repo/sources.ts';

/**
 * 任务失败邮件告警（issue #12）：worker 任务失败时通知站长，让源页面改版
 * 导致的断流当天就被发现（PRD user story 13），而不是静默腐烂。
 *
 * 行为约定：
 * - 收件人取环境变量 ALERT_EMAIL；未配置则整体跳过（不发也不落去重标记）；
 * - 去重键 = 本地日历日 × 任务名 × 源，落在 alert_sends 表 —— 同一天同一源
 *   同一任务类型只发一封，worker 重启后依然生效；
 * - 邮件发送失败不落去重标记，下一轮调度重试；本函数自身绝不抛出
 *   （内部吞错并记日志），调用点无需再包 try/catch 即可安全内联在失败路径。
 */
export interface TaskFailureAlertInput {
  /** 任务名（worker registry 的 Job.name，如 crawl-notices） */
  jobName: string;
  /** 源 ID；任务级失败（与具体源无关）传 null */
  sourceId: string | null;
  /** 错误摘要（一般取 error.message） */
  error: string;
  /** 发生时间（去重键的日期部分取其本地日历日） */
  now: Date;
  /** 日志函数（worker ctx.logger；缺省 console） */
  log?: (message: string) => void;
}

function logLine(log: ((message: string) => void) | undefined, message: string): void {
  (log ?? ((line: string) => console.log(`[alert] ${line}`)))(message);
}

/** 发送任务失败告警；实际发出返回 true，被去重 / 跳过 / 失败返回 false。 */
export async function sendTaskFailureAlert(input: TaskFailureAlertInput): Promise<boolean> {
  const recipient = process.env.ALERT_EMAIL?.trim();
  if (!recipient) {
    logLine(
      input.log,
      `未配置 ALERT_EMAIL，跳过任务失败告警（job=${input.jobName} source=${input.sourceId ?? '—'}）`,
    );
    return false;
  }

  const alertDate = localDateIso(input.now);
  const sourceId = input.sourceId ?? '';
  try {
    if (await hasAlertSend(alertDate, input.jobName, sourceId)) {
      logLine(
        input.log,
        `告警去重：${alertDate} 任务 ${input.jobName} 源 ${sourceId || '—'} 当日已发过，跳过`,
      );
      return false;
    }
  } catch (error) {
    // 去重查询失败按「未发过」处理，宁可多发不漏发
    logLine(input.log, `告警去重查询失败（按未发过处理）：${errorText(error)}`);
  }

  let sourceName: string | null = null;
  if (sourceId) {
    try {
      sourceName = (await getSourceById(sourceId))?.name ?? null;
    } catch {
      sourceName = null; // 源名仅用于展示，查询失败不影响告警发送
    }
  }

  try {
    const mailer = createMailerPort();
    await mailer.send(
      buildTaskFailureAlertEmail({
        to: recipient,
        jobName: input.jobName,
        sourceId: sourceId || null,
        sourceName,
        error: input.error,
        now: input.now,
      }),
    );
  } catch (error) {
    // 不落去重标记：下一轮任务失败时重试发送
    logLine(input.log, `告警邮件发送失败（下一轮重试）：${errorText(error)}`);
    return false;
  }

  try {
    await recordAlertSend(alertDate, input.jobName, sourceId, input.now.toISOString());
  } catch (error) {
    // 去重标记写入失败只影响当日重复抑制，记日志即可
    logLine(input.log, `告警去重标记写入失败（当日可能重复告警）：${errorText(error)}`);
  }
  logLine(input.log, `任务失败告警已发送 to=${recipient} job=${input.jobName} source=${sourceId || '—'}`);
  return true;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
