import Link from 'next/link';
import { CATEGORY_OPTIONS } from '@/lib/subscription';

/**
 * 订阅页（issue #7，double opt-in 第一步）：
 * 邮箱 + 关键词 / 领域规则 → POST /api/subscriptions 创建待确认订阅并发确认邮件。
 * 校验反馈经查询参数回显（错误 / 已发送 / 已更新横幅）。
 */

// 表单提交后经 303 重定向回本页并携带状态参数，始终实时渲染。
export const dynamic = 'force-dynamic';

const ERROR_MESSAGES: Record<string, string> = {
  invalid_email: '邮箱格式不正确，请检查后重试。',
  no_rules: '请至少填写一个关键词或选择一个领域。',
  unknown_category: '包含未知领域，请重新选择。',
  send_failed: '确认邮件发送失败，请稍后重试。',
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
  const updated = firstValue(params.updated) === '1';

  return (
    <main>
      <nav className="breadcrumb">
        <Link href="/">← 返回公示列表</Link>
      </nav>

      <header className="site-header">
        <h1 className="brand">订阅截止提醒</h1>
        <p className="tagline">
          按关键词 / 领域订阅公示提醒：征求意见截止前 7 天、3 天各收到一封提醒邮件。
        </p>
      </header>

      {sent ? (
        <p className="form-banner form-banner-ok" data-testid="subscribe-sent-banner">
          确认邮件已发送，请查收邮箱并点击确认链接；确认前订阅不生效，不会收到任何提醒邮件。
        </p>
      ) : null}
      {updated ? (
        <p className="form-banner form-banner-ok" data-testid="subscribe-updated-banner">
          你的订阅规则已更新，无需再次确认。
        </p>
      ) : null}
      {errorMessage ? (
        <p className="form-banner form-banner-error" data-testid="subscribe-error-banner">
          {errorMessage}
        </p>
      ) : null}

      <section className="subscribe-section" aria-labelledby="subscribe-form-title">
        <h2 id="subscribe-form-title">填写订阅规则</h2>
        <p className="section-hint">
          采用 double opt-in：提交后先收到一封确认邮件，点击确认链接后订阅才生效；
          每封邮件底部都可一键退订。本站仅存储订阅邮箱，不建立用户账号。
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
              data-testid="subscribe-email"
            />
          </div>

          <div className="form-field">
            <label htmlFor="subscribe-keywords">
              关键词（按空格或逗号分隔，命中条目标题或正文）
            </label>
            <input
              id="subscribe-keywords"
              type="text"
              name="keywords"
              placeholder="例如：医疗保障 噪声污染防治"
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
                    data-testid="subscribe-category-option"
                  />
                  {category}
                </label>
              ))}
            </div>
          </fieldset>

          <button type="submit" className="go-button" data-testid="subscribe-submit">
            提交订阅
          </button>
          <p className="section-hint">
            至少填写一个关键词或选择一个领域；确认邮件发送后订阅才会生效。
          </p>
        </form>
      </section>

      <footer className="site-footer">
        <p>提交意见请一律前往官方渠道；本站只聚合官方公开信息并提供解读与提醒。</p>
      </footer>
    </main>
  );
}
