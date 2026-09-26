import type { NoticeRecord, ReminderStage, SubscriptionRules } from '../db/types.ts';
import type { MailMessage } from './ports.ts';
import type { RuleMatchableSubscription } from './subscription.ts';
// HTML 转义（issue #37 建立，issue #83 起与后台共用一份实现）：本文件原本自带一份
// `escapeHtml`，与 `app/admin/admin-html.ts` 那份**逐字节相同** —— 两份的下场是
// "邮件那份有安全测试、后台那份一个都没有"。现在两边都打这一份，测试各从一侧覆盖。
import { escapeHtml } from './html-escape.ts';

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

/*
 * `escapeHtml` 的来源见文件头的 import（issue #83 合并）：那一段的完整理由
 * ——「凡是插进 html 正文的动态值都必须过这一层，包括 href 里的动态值」——
 * 连同实现一起搬到了 `lib/html-escape.ts`，别再在这里长回第二份。
 */

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

/**
 * 「查看或修改我的订阅」入口地址（issue #60 第 4 刀）。
 *
 * 刻意复用**退订 token**，不新签一类 token：它同样印在每封邮件底部、同样不轮换，
 * 因此能打开这个页面的人与能退订的人是同一批（= 能读该邮箱的人）—— 能力面没有变宽。
 * 真正的门槛在别处：改动必须再确认一次才生效，所以"知道某人邮箱"不再等于"能改其订阅"。
 */
function manageUrl(unsubscribeToken: string): string {
  return `${appBaseUrl()}/subscribe?token=${encodeURIComponent(unsubscribeToken)}`;
}

function rulesText(rules: RuleMatchableSubscription): string {
  const parts: string[] = [];
  if (rules.scope === 'all') return '订阅范围：收录的全部新公示（不限关键词 / 领域 / 机关）';
  if (rules.keywords.length > 0) parts.push(`关键词：${rules.keywords.join('、')}`);
  if (rules.categories.length > 0) parts.push(`领域：${rules.categories.join('、')}`);
  if ((rules.agencies ?? []).length > 0) parts.push(`发布机关：${rules.agencies.join('、')}`);
  return parts.join('\n');
}

/**
 * 确认邮件（double opt-in 第一步）：未确认前订阅不生效、不接收任何提醒。
 *
 * 带 `pendingRules` 时这是**已确认订阅的一次修改**（issue #60 第 4 刀）：信里显示新规则，
 * 同时明写「确认之前仍按原规则发送」—— 库里生效的还是旧的那份，说"已更新"就是撒谎。
 * 两种情况都必须发确认信：不再存在"重复提交直接改生效"这条路。
 */
export function buildConfirmationEmail(input: {
  email: string;
  rules: RuleMatchableSubscription;
  /** 非空 = 这是一次待确认的修改，信里显示的就是这份新规则 */
  pendingRules?: SubscriptionRules | null;
  confirmToken: string;
  unsubscribeToken: string;
}): MailMessage {
  const isUpdate = input.pendingRules !== undefined && input.pendingRules !== null;
  const shown = isUpdate ? (input.pendingRules as SubscriptionRules) : input.rules;
  const confirm = confirmUrl(input.confirmToken);
  const unsubscribe = unsubscribeUrl(input.unsubscribeToken);
  const manage = manageUrl(input.unsubscribeToken);
  return {
    to: input.email,
    subject: isUpdate ? '【主人翁】请确认你的订阅修改' : '【主人翁】请确认你的公示提醒订阅',
    text: [
      isUpdate
        ? '你（或他人）使用本邮箱在「主人翁」提交了订阅修改：'
        : '你（或他人）使用本邮箱在「主人翁」提交了公示提醒订阅：',
      '',
      rulesText(shown),
      '',
      isUpdate
        ? '请点击下面的链接确认这次修改。确认之前，本站仍按你原来的规则发送通知与提醒。'
        : '请点击下面的链接确认订阅，确认后订阅才生效：',
      confirm,
      '',
      `确认前你不会收到任何提醒邮件。如非本人操作，可忽略本邮件或通过下方链接退订。`,
      `查看或修改我的订阅：`,
      manage,
      `退订（打开页面后点确认）：`,
      unsubscribe,
      '',
      `——`,
      SITE_FOOTER,
    ].join('\n'),
    html: [
      isUpdate
        ? '<p>你（或他人）使用本邮箱在「主人翁」提交了<b>订阅修改</b>：</p>'
        : '<p>你（或他人）使用本邮箱在「主人翁」提交了公示提醒订阅：</p>',
      `<p>${escapeHtml(rulesText(shown)).replaceAll('\n', '<br>')}</p>`,
      isUpdate
        ? `<p>请<a href="${confirm}">点击这里确认这次修改</a>。<b>确认之前，本站仍按你原来的规则发送通知与提醒。</b></p>`
        : `<p>请<a href="${confirm}">点击这里确认订阅</a>，确认后订阅才生效；确认前你不会收到任何提醒邮件。</p>`,
      `<p><a href="${manage}">查看或修改我的订阅</a> · 如非本人操作，可忽略本邮件，或<a href="${unsubscribe}">退订（打开页面后点确认）</a>。</p>`,
      `<p>——<br>${SITE_FOOTER}</p>`,
    ].join('\n'),
    headers: unsubscribeHeaders(input.unsubscribeToken),
  };
}

const STAGE_LABELS: Record<ReminderStage, string> = { d7: '截止前 7 天', d3: '截止前 3 天' };

/** 各档的名义天数（补发标注用）：提醒按「已到档且未发过」判定，所以实际发出时可能已晚几天。 */
const STAGE_NOMINAL_DAYS: Record<ReminderStage, number> = { d7: 7, d3: 3 };

/**
 * 剩余天数的读者说法（issue #79）。
 *
 * `daysUntil` 的 0 表示**今天就是截止日**，而旧文案把它直接拼成「还剩 0 天」——
 * 生产实测发出的 5 封提醒全是这个样子（订阅 09-21 建立，而 worker 那天起没跑，
 * 7 天档一路补到 09-26 当天才发出去）。"还剩 0 天"既不像人话，也让人以为已经晚了：
 * 今天恰恰是**还能提意见的最后一天**，这句必须说成「今天截止」。
 */
function remainingDaysText(days: number): string {
  if (days < 0) return '已过截止日期';
  if (days === 0) return '今天截止';
  return `还剩 ${days} 天`;
}

/**
 * 补发标注（issue #79）：**一层括号、一件事只说一遍**。
 *
 * 旧文案在补发时是「（还剩 0 天，截止前 7 天档补发（原定提前 7 天，实际剩 0 天））」——
 * 双层括号，且"剩 0 天"刚说完又说一遍。现在它是一句并列的补充，用「；」接在同一层括号里：
 * 主句只说事实（哪一天截止、还剩几天），补发那件事另说，而且**不再重复天数**。
 * 不写「截止前 7 天提醒」而实际剩 2 天 —— 那是界面在撒谎，所以补发这件事必须照实说。
 */
function reminderStageNote(stage: ReminderStage, days: number): string {
  const nominal = STAGE_NOMINAL_DAYS[stage];
  return days === nominal ? '' : `；本档原定在${STAGE_LABELS[stage]}发出，这次是补发`;
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
  const remaining = remainingDaysText(days);
  const subject = `【主人翁】截止提醒：${notice.title}（${remaining}）`;
  return {
    to: input.email,
    subject,
    // 标题**只在第一行出现一次**（issue #79）：旧文案第一行是
    // `你订阅的公示「${title}」征求意见即将截止：`，而标题本身就常以「征求意见」结尾
    // （全库恰好 5 条这样，实测发出的 5 封全部中招）⇒ 念成「…征求意见征求意见即将截止」；
    // 紧接着第二行又原样重复一次标题。现在首行不再拼任何后缀，第二行取消。
    text: [
      `你订阅的公示「${notice.title}」即将截止：`,
      '',
      `截止日期：${notice.deadlineAt ?? '未标注'}（${remaining}${reminderStageNote(stage, days)}）`,
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
      `<p>你订阅的公示「${escapeHtml(notice.title)}」即将截止：</p>`,
      `<p>截止日期：<strong>${escapeHtml(notice.deadlineAt ?? '未标注')}</strong>（${escapeHtml(remaining + reminderStageNote(stage, days))}）</p>`,
      `<p><a href="${escapeHtml(detail)}">站内详情（含 AI 摘要与提意指引）</a></p>`,
      `<p><a href="${escapeHtml(notice.url)}">官方原文（请前往官方渠道提交意见）</a></p>`,
      `<p>${escapeHtml(REMINDER_POLICY_TEXT)}不想再收到提醒？<a href="${escapeHtml(unsubscribe)}">退订（打开页面后点确认）</a>。</p>`,
      `<p>——<br>${SITE_FOOTER}</p>`,
    ].join('\n'),
    headers: unsubscribeHeaders(input.unsubscribeToken),
  };
}

/** 一封新公示通知里最多列几条（超出部分只报数，不拆成第二封信） */
export const MAX_NOTICES_PER_EMAIL = 20;

/**
 * 新公示通知（issue #60 第 3 刀）：一位订阅者一封汇总邮件。
 *
 * 为什么不是一条一封：日发信量有限制（个人 SMTP），而"新增三条就收到三封信"
 * 比"一封里三条"更容易被当成骚扰直接退订。超出上限时列前 N 条 + 报剩余条数，
 * 剩余那些仍会写去重标记吗？—— **不会**（见任务层）：没写进信里的条目下一轮还会带来，
 * 否则用户就永远看不到它们却以为已通知过了。
 *
 * 刻意不提"含 AI 摘要"：新公示的摘要可能还没生成（摘要任务在通知之后或本轮失败），
 * 邮件里承诺了页面上没有的东西，就是 issue #22/#58 反复清掉的那类谎。
 */
export function buildNewNoticesEmail(input: {
  email: string;
  notices: NoticeRecord[];
  /** 因条数上限没列进本信的同组条目数（下一轮会再来） */
  overflowCount: number;
  unsubscribeToken: string;
  now: string;
}): MailMessage {
  const first = input.notices[0];
  const subject =
    input.notices.length === 1
      ? `【主人翁】新公示：${first.title}`
      : `【主人翁】新公示 ${input.notices.length} 条：${first.title} 等`;
  const unsubscribe = unsubscribeUrl(input.unsubscribeToken);
  const lines = input.notices.map((notice) => {
    const detail = noticeDetailUrl(notice.id);
    return [
      `· ${notice.title}`,
      `  发布机关：${notice.agency}`,
      `  截止日期：${notice.deadlineAt ?? '源站未标注'}`,
      `  站内详情：${detail}`,
      `  官方原文：${notice.url}`,
    ].join('\n');
  });
  const overflowNote =
    input.overflowCount > 0
      ? `另有 ${input.overflowCount} 条本次未列入（每封邮件最多 ${MAX_NOTICES_PER_EMAIL} 条），会在下一封里发出。`
      : '';
  return {
    to: input.email,
    subject,
    text: [
      '根据你订阅的条件，本站有新的公示收录：',
      '',
      ...lines,
      overflowNote === '' ? '' : overflowNote,
      '',
      '本站只聚合官方公开信息，不代替官方受理意见；提意见请前往上面的官方原文链接。',
      '不想再收到这类通知？退订（打开页面后点确认）：',
      unsubscribe,
      '',
      '——',
      SITE_FOOTER,
    ]
      .filter((line) => line !== undefined)
      .join('\n'),
    html: [
      '<p>根据你订阅的条件，本站有新的公示收录：</p>',
      '<ul>',
      input.notices
        .map((notice) => {
          const detail = noticeDetailUrl(notice.id);
          return (
            `<li><a href="${escapeHtml(detail)}">${escapeHtml(notice.title)}</a>`
            + `<br>发布机关：${escapeHtml(notice.agency)}；截止日期：${escapeHtml(notice.deadlineAt ?? '源站未标注')}；`
            + `<a href="${escapeHtml(notice.url)}">官方原文↗</a></li>`
          );
        })
        .join('\n'),
      '</ul>',
      overflowNote === '' ? '' : `<p>${escapeHtml(overflowNote)}</p>`,
      `<p>本站只聚合官方公开信息，不代替官方受理意见；提意见请点上面的官方原文链接。</p>`,
      `<p>不想再收到这类通知？<a href="${escapeHtml(unsubscribe)}">退订（打开页面后点确认）</a>。</p>`,
      `<p>——<br>${SITE_FOOTER}</p>`,
    ]
      .filter((part) => part !== '')
      .join('\n'),
    headers: unsubscribeHeaders(input.unsubscribeToken),
  };
}
