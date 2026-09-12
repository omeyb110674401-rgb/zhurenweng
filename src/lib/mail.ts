import type { NoticeRecord, ReminderStage } from '../db/types.ts';
import type { MailMessage } from './ports.ts';
import type { RuleMatchableSubscription } from './subscription.ts';

/**
 * 邮件内容构建（issue #7）：确认邮件与截止提醒邮件。
 *
 * 链接基于 APP_BASE_URL（生产为站点对外地址，E2E 注入应用服务器地址）。
 * 合规要求：确认邮件与提醒邮件底部都带一键退订链接；提醒邮件必须含
 * 截止日期与官方原文（提意）链接 —— 只引流，不代替官方受理意见。
 */

/** 站点对外基础地址（去掉末尾斜杠）。 */
export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}

const SITE_FOOTER = '主人翁 · 政府公示与征求意见信息聚合（发现 · 读懂 · 行动）';

function confirmUrl(confirmToken: string): string {
  return `${appBaseUrl()}/subscribe/confirm?token=${encodeURIComponent(confirmToken)}`;
}

export function unsubscribeUrl(unsubscribeToken: string): string {
  return `${appBaseUrl()}/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;
}

export function noticeDetailUrl(noticeId: string): string {
  return `${appBaseUrl()}/notices/${noticeId}`;
}

function rulesText(rules: RuleMatchableSubscription): string {
  const parts: string[] = [];
  if (rules.keywords.length > 0) parts.push(`关键词：${rules.keywords.join('、')}`);
  if (rules.categories.length > 0) parts.push(`领域：${rules.categories.join('、')}`);
  return parts.join('\n');
}

/** 确认邮件（double opt-in 第一步）：未确认前订阅不生效、不接收任何提醒。 */
export function buildConfirmationEmail(input: {
  email: string;
  rules: RuleMatchableSubscription;
  confirmToken: string;
  unsubscribeToken: string;
}): MailMessage {
  const confirm = confirmUrl(input.confirmToken);
  const unsubscribe = unsubscribeUrl(input.unsubscribeToken);
  return {
    to: input.email,
    subject: '【主人翁】请确认你的公示提醒订阅',
    text: [
      '你（或他人）使用本邮箱在「主人翁」提交了公示提醒订阅：',
      '',
      rulesText(input.rules),
      '',
      `请点击下面的链接确认订阅，确认后订阅才生效：`,
      confirm,
      '',
      `确认前你不会收到任何提醒邮件。如非本人操作，可忽略本邮件或通过下方链接一键退订。`,
      `一键退订（拒收全部邮件）：`,
      unsubscribe,
      '',
      `——`,
      SITE_FOOTER,
    ].join('\n'),
    html: [
      '<p>你（或他人）使用本邮箱在「主人翁」提交了公示提醒订阅：</p>',
      `<p>${rulesText(input.rules).replaceAll('\n', '<br>')}</p>`,
      `<p>请<a href="${confirm}">点击这里确认订阅</a>，确认后订阅才生效；确认前你不会收到任何提醒邮件。</p>`,
      `<p>如非本人操作，可忽略本邮件，或<a href="${unsubscribe}">一键退订（拒收全部邮件）</a>。</p>`,
      `<p>——<br>${SITE_FOOTER}</p>`,
    ].join('\n'),
  };
}

const STAGE_LABELS: Record<ReminderStage, string> = { d7: '截止前 7 天', d3: '截止前 3 天' };

/**
 * 任务失败告警邮件（issue #12）：worker 任务失败时发给站长（ALERT_EMAIL）。
 * 内容含任务名、源（任务级失败为「—」）、发生时间与错误摘要（截断防爆炸）；
 * 去重（同日 × 任务 × 源只发一封）在发送方 src/lib/alerts.ts 落表控制。
 */

/** 错误摘要截断长度：告警邮件只要能定位问题，不需要整段堆栈 */
const MAX_ALERT_ERROR_LENGTH = 600;

/** 源健康告警的展示标签：任务级失败（无具体源）用「—」。 */
export const ALERT_NO_SOURCE_LABEL = '—';

export function buildTaskFailureAlertEmail(input: {
  to: string;
  jobName: string;
  /** 源 ID；任务级（与具体源无关）失败传 null */
  sourceId: string | null;
  sourceName: string | null;
  error: string;
  now: Date;
}): MailMessage {
  const sourceLabel = input.sourceId
    ? `${input.sourceName ?? input.sourceId}（${input.sourceId}）`
    : ALERT_NO_SOURCE_LABEL;
  const occurredAt = input.now.toISOString();
  const errorSummary =
    input.error.length > MAX_ALERT_ERROR_LENGTH
      ? `${input.error.slice(0, MAX_ALERT_ERROR_LENGTH)}…（已截断）`
      : input.error;
  const subject = `【主人翁】任务失败告警：${input.jobName}（源：${sourceLabel}）`;
  return {
    to: input.to,
    subject,
    text: [
      '主人翁数据管线任务失败：',
      '',
      `任务：${input.jobName}`,
      `源：${sourceLabel}`,
      `时间：${occurredAt}`,
      `错误摘要：${errorSummary}`,
      '',
      '同一任务同一源同一天只发送一封告警；修复后下一轮调度会自动重试。',
      '',
      `——`,
      SITE_FOOTER,
    ].join('\n'),
    html: [
      '<p>主人翁数据管线任务失败：</p>',
      `<p>任务：<strong>${input.jobName}</strong><br>源：<strong>${sourceLabel}</strong><br>时间：${occurredAt}</p>`,
      `<pre>${errorSummary}</pre>`,
      '<p>同一任务同一源同一天只发送一封告警；修复后下一轮调度会自动重试。</p>',
      `<p>——<br>${SITE_FOOTER}</p>`,
    ].join('\n'),
  };
}

/** 截止提醒邮件：标题、剩余天数、截止日期、站内详情与官方原文（提意）链接。 */
export function buildReminderEmail(input: {
  email: string;
  notice: NoticeRecord;
  /** 距截止日期的日历天数（7 或 3） */
  days: number;
  stage: ReminderStage;
  unsubscribeToken: string;
}): MailMessage {
  const { notice, days, stage } = input;
  const detail = noticeDetailUrl(notice.id);
  const unsubscribe = unsubscribeUrl(input.unsubscribeToken);
  const subject = `【主人翁】截止提醒：${notice.title}（剩 ${days} 天）`;
  return {
    to: input.email,
    subject,
    text: [
      `你订阅的公示「${notice.title}」征求意见即将截止：`,
      '',
      `标题：${notice.title}`,
      `截止日期：${notice.deadlineAt ?? '未标注'}（还剩 ${days} 天，${STAGE_LABELS[stage]}提醒）`,
      `站内详情（含 AI 摘要与提意指引）：`,
      detail,
      `官方原文（请前往官方渠道提交意见）：`,
      notice.url,
      '',
      `本提醒按你的订阅规则发送，每条公示截止前 7 天、3 天各提醒一次。`,
      `不想再收到提醒？一键退订：`,
      unsubscribe,
      '',
      `——`,
      SITE_FOOTER,
    ].join('\n'),
    html: [
      `<p>你订阅的公示「${notice.title}」征求意见即将截止：</p>`,
      `<p>截止日期：<strong>${notice.deadlineAt ?? '未标注'}</strong>（还剩 ${days} 天，${STAGE_LABELS[stage]}提醒）</p>`,
      `<p><a href="${detail}">站内详情（含 AI 摘要与提意指引）</a></p>`,
      `<p><a href="${notice.url}">官方原文（请前往官方渠道提交意见）</a></p>`,
      `<p>本提醒按你的订阅规则发送，每条公示截止前 7 天、3 天各提醒一次。不想再收到提醒？<a href="${unsubscribe}">一键退订</a>。</p>`,
      `<p>——<br>${SITE_FOOTER}</p>`,
    ].join('\n'),
  };
}
