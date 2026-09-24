import type { NoticeRecord, ReminderStage } from '../db/types.ts';
import type { MailMessage } from './ports.ts';
import type { RuleMatchableSubscription } from './subscription.ts';

/**
 * 邮件内容构建（issue #7）：确认邮件与截止提醒邮件。
 *
 * 链接基于 APP_BASE_URL（生产为站点对外地址，E2E 注入应用服务器地址）。
 * 合规要求：确认邮件与提醒邮件底部都带退订链接；提醒邮件必须含
 * 截止日期与官方原文（提意）链接 —— 只引流，不代替官方受理意见。
 *
 * 退订与「一键退订」头（issue #34）：
 * - 正文里的链接指向**只读的确认页** `/unsubscribe?token=…`（打开不会退订），
 *   真正的退订由页面按钮 POST 到 `/unsubscribe/one-click` 完成；
 * - 同时带上 `List-Unsubscribe`（指向动作端点）与
 *   `List-Unsubscribe-Post: List-Unsubscribe=One-Click`（RFC 8058）：邮件客户端
 *   自带的「退订」按钮会直接 POST，立即生效。
 * 这样邮件网关预取正文链接（GET）不会静默退订，而用户想退订时反而更省事。
 */

/** 站点对外基础地址（去掉末尾斜杠）。 */
export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}

const SITE_FOOTER = '主人翁 · 政府公示与征求意见信息聚合（发现 · 读懂 · 行动）';

/**
 * HTML 转义（issue #37）：**凡是插进 html 正文的动态值都必须过这一层**，
 * 包括 href 里的动态值 —— 属性里一个双引号就能跳出引号、改写整段标记，
 * 而官方原文链接来自源站、退订链接带用户 token，都不是本站能替其担保的内容。
 *
 * 为什么必须做：邮件正文是手工拼的 HTML 字符串，此前把用户输入与库内数据直接插值 ——
 * 订阅关键词来自表单（`关键词：<b>x</b>` 会被当标签渲染）、错误摘要来自抓取失败的
 * 原始报文、条目标题来自源站。后果不只是排版乱：任何人可以用**别人的邮箱**提交带
 * HTML 的订阅规则，收件人收到的确认邮件里就会渲染攻击者控制的标签与链接（钓鱼面）。
 * 纯文本部分（text）不需要转义，用户看到的就是字面内容。
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function confirmUrl(confirmToken: string): string {
  return `${appBaseUrl()}/subscribe/confirm?token=${encodeURIComponent(confirmToken)}`;
}

/** 退订确认页（只读，打开不退订）——正文里的链接用这个。 */
export function unsubscribeUrl(unsubscribeToken: string): string {
  return `${appBaseUrl()}/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;
}

/** 退订动作端点（POST）——邮件头 List-Unsubscribe 用这个。 */
export function unsubscribeOneClickUrl(unsubscribeToken: string): string {
  return `${appBaseUrl()}/unsubscribe/one-click?token=${encodeURIComponent(unsubscribeToken)}`;
}

/**
 * RFC 8058 一键退订头：客户端点「退订」时 POST 到动作端点，立即生效。
 * 附带 `List-Unsubscribe-Post` 才表示「支持一键退订」。
 */
function unsubscribeHeaders(unsubscribeToken: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${unsubscribeOneClickUrl(unsubscribeToken)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

export function noticeDetailUrl(noticeId: string): string {
  return `${appBaseUrl()}/notices/${noticeId}`;
}

function rulesText(rules: RuleMatchableSubscription): string {
  const parts: string[] = [];
  if (rules.scope === 'all') return '订阅范围：收录的全部新公示（不限关键词 / 领域 / 机关）';
  if (rules.keywords.length > 0) parts.push(`关键词：${rules.keywords.join('、')}`);
  if (rules.categories.length > 0) parts.push(`领域：${rules.categories.join('、')}`);
  if ((rules.agencies ?? []).length > 0) parts.push(`发布机关：${rules.agencies.join('、')}`);
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
      `确认前你不会收到任何提醒邮件。如非本人操作，可忽略本邮件或通过下方链接退订。`,
      `退订（打开页面后点确认）：`,
      unsubscribe,
      '',
      `——`,
      SITE_FOOTER,
    ].join('\n'),
    html: [
      '<p>你（或他人）使用本邮箱在「主人翁」提交了公示提醒订阅：</p>',
      `<p>${escapeHtml(rulesText(input.rules)).replaceAll('\n', '<br>')}</p>`,
      `<p>请<a href="${confirm}">点击这里确认订阅</a>，确认后订阅才生效；确认前你不会收到任何提醒邮件。</p>`,
      `<p>如非本人操作，可忽略本邮件，或<a href="${unsubscribe}">退订（打开页面后点确认）</a>。</p>`,
      `<p>——<br>${SITE_FOOTER}</p>`,
    ].join('\n'),
    headers: unsubscribeHeaders(input.unsubscribeToken),
  };
}

const STAGE_LABELS: Record<ReminderStage, string> = { d7: '截止前 7 天', d3: '截止前 3 天' };

/** 各档的名义天数（补发标注用）：提醒按「已到档且未发过」判定，所以实际发出时可能已晚几天。 */
const STAGE_NOMINAL_DAYS: Record<ReminderStage, number> = { d7: 7, d3: 3 };

/**
 * 截止日那一行的文案。
 *
 * 不写「截止前 7 天提醒」而实际剩 2 天 —— 那是界面在撒谎。任务停摆导致补发时如实标注，
 * 顺带也解释了为什么有人会比别人晚收到一封。
 */
function reminderStageNote(stage: ReminderStage, days: number): string {
  const nominal = STAGE_NOMINAL_DAYS[stage];
  return days === nominal
    ? `${STAGE_LABELS[stage]}档`
    : `${STAGE_LABELS[stage]}档补发（原定提前 ${nominal} 天，实际剩 ${days} 天）`;
}

/** 订阅侧的固定承诺：两档各一封，漏跑的那天下一轮补上。 */
const REMINDER_POLICY_TEXT =
  '本提醒按你的订阅规则发送，每条公示的截止前 7 天、3 天各提醒一次；某一天任务没跑成，该档会在下一轮补发一次（不会重复发）。';

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
      '同一任务同一源同一天至多一封；持续故障按抓取轮次重发（连续第 2 轮一封，之后每 7 轮一封），首轮抖动只记录不发信；修复后下一轮调度会自动重试。',
      '',
      `——`,
      SITE_FOOTER,
    ].join('\n'),
    html: [
      '<p>主人翁数据管线任务失败：</p>',
      `<p>任务：<strong>${escapeHtml(input.jobName)}</strong><br>源：<strong>${escapeHtml(sourceLabel)}</strong><br>时间：${escapeHtml(occurredAt)}</p>`,
      `<pre>${escapeHtml(errorSummary)}</pre>`,
      '<p>同一任务同一源同一天至多一封；持续故障按抓取轮次重发（连续第 2 轮一封，之后每 7 轮一封），首轮抖动只记录不发信；修复后下一轮调度会自动重试。</p>',
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
      `截止日期：${notice.deadlineAt ?? '未标注'}（还剩 ${days} 天，${reminderStageNote(stage, days)}）`,
      `站内详情（含 AI 摘要与提意指引）：`,
      detail,
      `官方原文（请前往官方渠道提交意见）：`,
      notice.url,
      '',
      `${REMINDER_POLICY_TEXT}`,
      `不想再收到提醒？退订（打开页面后点确认）：`,
      unsubscribe,
      '',
      `——`,
      SITE_FOOTER,
    ].join('\n'),
    html: [
      `<p>你订阅的公示「${escapeHtml(notice.title)}」征求意见即将截止：</p>`,
      `<p>截止日期：<strong>${escapeHtml(notice.deadlineAt ?? '未标注')}</strong>（还剩 ${days} 天，${reminderStageNote(stage, days)}）</p>`,
      `<p><a href="${escapeHtml(detail)}">站内详情（含 AI 摘要与提意指引）</a></p>`,
      `<p><a href="${escapeHtml(notice.url)}">官方原文（请前往官方渠道提交意见）</a></p>`,
      `<p>${escapeHtml(REMINDER_POLICY_TEXT)}不想再收到提醒？<a href="${escapeHtml(unsubscribe)}">退订（打开页面后点确认）</a>。</p>`,
      `<p>——<br>${SITE_FOOTER}</p>`,
    ].join('\n'),
    headers: unsubscribeHeaders(input.unsubscribeToken),
  };
}
