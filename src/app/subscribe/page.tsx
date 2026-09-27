import Link from 'next/link';
import { cookies } from 'next/headers';
import { AUDIENCE_OPTIONS, CATEGORY_OPTIONS } from '@/lib/subscription';
import { listNoticeAgencies } from '@/db/repo/notices';
import { findSubscriptionByUnsubscribeToken } from '@/db/repo/subscriptions';
import { mailerReady } from '@/lib/mailer-availability';
import { simplePageMetadata } from '@/lib/page-metadata';
import {
  decodeSubscribeDraft,
  SUBSCRIBE_DRAFT_COOKIE,
  type SubscribeDraft,
} from '@/lib/subscribe-draft';
import { SiteFooter } from '@/app/_lib/site-footer';

/**
 * 订阅页（issue #7，double opt-in 第一步）：
 * 邮箱 + 关键词 / 领域规则 → POST /api/subscriptions 创建待确认订阅并发确认邮件。
 * 校验反馈经查询参数回显（错误 / 已发送 / 已更新横幅）。
 *
 * 邮件端口门控（issue #17）：`MAILER_PROVIDER=smtp` 但 SMTP_* 未配置时表单必然
 * 提交失败，此时渲染不可用提示与 RSS 兜底，不渲染表单（见 mailer-availability.ts）。
 *
 * 失败回填（issue #53）：校验失败时端点会把已填内容放进短命 cookie（见
 * lib/subscribe-draft.ts），本页读它做默认值 —— 此前一次「漏选领域」就要把邮箱、
 * 关键词、勾选全部重填一遍。
 */

// 表单提交后经 303 重定向回本页并携带状态参数，始终实时渲染。
export const dynamic = 'force-dynamic';

export const metadata = simplePageMetadata({
  title: '订阅公示提醒',
  description:
    '按关键词、领域、发布机关或受众面（公众广域 / 行业专业）订阅政府公示与征求意见稿，也可直接订全部新公示：有新公示收录时收到一封汇总邮件，截止前 7 天、3 天各收到一封提醒邮件（同一轮多条合并成一封）。采用 double opt-in（先确认再生效），每封邮件底部都能一键退订，本站只存邮箱、不建账号。',
  path: '/subscribe',
});

const ERROR_MESSAGES: Record<string, string> = {
  invalid_email: '邮箱格式不正确，请检查后重试。',
  invalid_form: '提交的数据格式不正确，请从订阅页重新提交。',
  no_rules:
    '请至少填写一个关键词、选择一个领域、一个发布机关或一档受众面；或改选「订全部新公示」。',
  unknown_category: '包含未知领域，请重新选择。',
  unknown_audience: '包含未知的受众面，请重新选择。',
  send_failed: '确认邮件发送失败，请稍后重试。',
  mailer_unavailable: '邮件订阅暂未开放（邮件通道配置中），请先用 RSS 订阅。',
  rate_limited: '提交过于频繁，已暂时拒绝本次请求。请稍后再试。',
};

interface SubscribePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SubscribePage({ searchParams }: SubscribePageProps) {
  const params = await searchParams;
  const error = firstValue(params.error);
  const errorMessage = error !== undefined ? ERROR_MESSAGES[error] : undefined;
  const sent = firstValue(params.sent) === '1';

  // 只有「带着错误回来」时才读草稿（issue #53）：正常访问不该被上一轮的输入影响。
  // 读不到或解析失败都当没有草稿，绝不让它打断渲染。
  const draft =
    errorMessage !== undefined
      ? decodeSubscribeDraft((await cookies()).get(SUBSCRIBE_DRAFT_COOKIE)?.value)
      : null;

  // 机关候选取库内实际出现过的发布机关（issue #60）：写死一份清单必然过期。
  // 表单不可用时不查（那条路径根本不渲染选择项）。
  const mailReady = mailerReady();
  const agencyOptions = mailReady ? await listNoticeAgencies() : [];

  // 「查看或修改我的订阅」：邮件底部的链接带着退订 token（issue #60 第 4 刀）。
  // 预填用的是**待确认的那份**（如果有）—— 用户上次提交的改动还没生效，
  // 给他看正式规则会让他以为自己改丢了，于是再改一遍。
  const token = firstValue(params.token)?.trim() ?? '';
  const managed = mailReady && token !== '' ? await findSubscriptionByUnsubscribeToken(token) : null;
  const manageDraft: SubscribeDraft | null = managed
    ? {
        email: managed.email,
        keywords: (managed.pending?.keywords ?? managed.keywords).join(' '),
        categories: managed.pending?.categories ?? managed.categories,
        agencies: managed.pending?.agencies ?? managed.agencies,
        audiences: managed.pending?.audiences ?? managed.audiences,
        scope: (managed.pending?.scope ?? managed.scope) === 'all' ? 'all' : 'rules',
      }
    : null;

  return (
    <main id="main-content">
      <nav className="breadcrumb">
        <Link href="/">← 返回公示列表</Link>
      </nav>

      <header className="site-header">
        <h1 className="brand">订阅公示提醒</h1>
        <p className="tagline">
          按关键词 / 领域 / 发布机关订阅，也可以按受众面收窄到「公众广域」或「行业专业」，
          或直接订全部新公示：有新公示时收到一封汇总，截止前 7 天、3 天各收到一封提醒邮件
          （同一轮里多条会合并成一封）。
        </p>
      </header>

      {sent ? (
        <p className="form-banner form-banner-ok" data-testid="subscribe-sent-banner">
          已收到你的提交：<b>请查收确认邮件并点击确认链接</b> —— 新订阅在确认前不生效；
          若这是对一个已确认订阅的修改，<b>确认之前本站仍按你原来的规则发送</b>通知与提醒。
          确认前旧链接会失效，这是正常的：每次提交都换发一个新的确认链接。
        </p>
      ) : null}
      {managed ? (
        <p className="form-banner form-banner-ok" data-testid="subscribe-manage-banner">
          {managed.unsubscribedAt !== null
            ? '这个邮箱已退订。下面的内容是你上次的订阅设置，重新提交并按邮件确认后会重新生效。'
            : '你正在修改已有订阅。下面的内容是当前生效的设置'
              + (managed.pending !== null ? '（其中还有一次尚未确认的改动，已一并回填）' : '')
              + '；提交后需要再点一次确认邮件里的按钮才生效，确认之前仍按原规则发送。'}
        </p>
      ) : null}
      {errorMessage ? (
        <p className="form-banner form-banner-error" data-testid="subscribe-error-banner">
          {errorMessage}
        </p>
      ) : null}

      {mailReady ? (
        <SubscribeFormSection draft={manageDraft ?? draft} agencyOptions={agencyOptions} />
      ) : (
        <SubscribeUnavailableSection />
      )}

      <SiteFooter />
    </main>
  );
}

/**
 * 可用态：订阅规则表单（邮箱 + 范围 + 关键词 / 领域 / 机关）。
 * `draft` 非空时回填上一次的输入（issue #53）。
 *
 * 范围放在条件**之前**（issue #60）：选「全部新公示」时下面三项不再生效，
 * 这个先后关系必须一眼看得见 —— 否则用户会以为自己勾的关键词还在起作用，
 * 而实际上他收到的是每一条新公示。
 */
function SubscribeFormSection({
  draft,
  agencyOptions,
}: {
  draft: SubscribeDraft | null;
  agencyOptions: string[];
}) {
  return (
    <section className="subscribe-section" aria-labelledby="subscribe-form-title">
      <h2 id="subscribe-form-title">填写订阅规则</h2>
      <p className="section-hint">
        订阅后会收到两类邮件：本站有新公示收录时的一封汇总，以及截止前 7 天、3 天的提醒
        （同一轮里多条同时到档会合并成一封，不按条数连发）。
        采用 double opt-in：提交后先收到一封确认邮件，点击确认链接后订阅才生效；
        每封邮件底部都可一键退订。本站仅存储订阅邮箱，不建立用户账号。
        {draft !== null ? '（已保留你上次填写的内容）' : null}
      </p>

      <form
        className="subscribe-form"
        action="/api/subscriptions"
        method="post"
        data-testid="subscribe-form"
      >
        <div className="form-field">
          <label htmlFor="subscribe-email">邮箱</label>
          <input
            id="subscribe-email"
            type="email"
            name="email"
            required
            placeholder="you@example.com"
            defaultValue={draft?.email ?? ''}
            data-testid="subscribe-email"
          />
        </div>

        <fieldset className="form-field">
          <legend>订阅范围</legend>
          <div className="scope-options" data-testid="subscribe-scope">
            <label className="scope-option">
              <input
                type="radio"
                value="rules"
                name="scope"
                defaultChecked={(draft?.scope ?? 'rules') !== 'all'}
                data-testid="subscribe-scope-rules"
              />
              只订命中我下面所选条件的公示
            </label>
            <label className="scope-option">
              <input
                type="radio"
                value="all"
                name="scope"
                defaultChecked={draft?.scope === 'all'}
                data-testid="subscribe-scope-all"
              />
              订全部新公示（不限条件；选这项时下面三项不再生效）
            </label>
          </div>
        </fieldset>

        <fieldset className="form-field">
          <legend>受众面（可选，勾了就只发这几类）</legend>
          <p className="section-hint" data-testid="subscribe-audience-hint">
            受众面答的是「这份公示该谁去提意见」：<b>公众广域</b>是立法、税收、社保医保一类
            面向不特定多数人的；<b>行业专业</b>是技术标准、行业规程、许可准入一类读者以从业者为主。
            不勾 = 不限。勾了之后只有这几类会发给你 —— 它与下面的关键词 / 领域 / 机关是
            <b>「并且」</b>的关系（先命中条件，再看受众面是不是你要的那类），不是"再多命中一档"。
            只勾受众面也可以：那就是「这类公示我都要」。判不出受众面的少数条目不在这两档里。
          </p>
          <div className="category-options" data-testid="subscribe-audiences">
            {AUDIENCE_OPTIONS.map((option) => (
              <label key={option.value} className="category-option" title={option.hint}>
                <input
                  type="checkbox"
                  name="audiences"
                  value={option.value}
                  defaultChecked={draft?.audiences.includes(option.value) ?? false}
                  data-testid="subscribe-audience-option"
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="form-field">
          <label htmlFor="subscribe-keywords">
            关键词（按空格或逗号分隔，命中条目标题或正文）
          </label>
          <input
            id="subscribe-keywords"
            type="text"
            name="keywords"
            placeholder="例如：医疗保障 噪声污染防治"
            defaultValue={draft?.keywords ?? ''}
            data-testid="subscribe-keywords"
          />
        </div>

        <fieldset className="form-field">
          <legend>领域（可多选，命中条目领域标签）</legend>
          <div className="category-options" data-testid="subscribe-categories">
            {CATEGORY_OPTIONS.map((category) => (
              <label key={category} className="category-option">
                <input
                  type="checkbox"
                  name="categories"
                  value={category}
                  defaultChecked={draft?.categories.includes(category) ?? false}
                  data-testid="subscribe-category-option"
                />
                {category}
              </label>
            ))}
          </div>
        </fieldset>

        {agencyOptions.length > 0 ? (
          <fieldset className="form-field">
            <legend>发布机关（可多选，联合发文按每一个参与机关算）</legend>
            <div className="category-options" data-testid="subscribe-agencies">
              {agencyOptions.map((agency) => (
                <label key={agency} className="category-option">
                  <input
                    type="checkbox"
                    name="agencies"
                    value={agency}
                    defaultChecked={draft?.agencies.includes(agency) ?? false}
                    data-testid="subscribe-agency-option"
                  />
                  {agency}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        <button type="submit" className="go-button" data-testid="subscribe-submit">
          提交订阅
        </button>
        <p className="section-hint">
          「只订命中条件的」时需至少填写一个关键词、选一个领域、一个机关或一档受众面；
          确认邮件发送后订阅才会生效。
        </p>
      </form>
    </section>
  );
}

/**
 * 不可用态（邮件通道未配置）：给清楚的原因与 RSS 兜底，不渲染必然失败的表单。
 * 提示里刻意不出现 subscribe-form / subscribe-email 等表单标识 —— 前端脚本与
 * 测试据此判断「没有表单」。
 */
function SubscribeUnavailableSection() {
  return (
    <section className="subscribe-section" data-testid="subscribe-unavailable">
      <h2>邮件订阅暂未开放</h2>
      <p className="form-banner form-banner-error" data-testid="subscribe-unavailable-banner">
        邮件订阅暂未开放：本站的邮件发送通道正在配置中，现在提交订阅无法收到确认邮件，
        因此暂时关闭表单。
      </p>
      <p className="section-hint">
        在邮件提醒上线前，可以先用
        <a href="/feed.xml" data-testid="subscribe-unavailable-rss">
          RSS 订阅
        </a>
        全部公示（任何阅读器都能用，新公示即时推送）。
      </p>
    </section>
  );
}
